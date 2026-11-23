import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import * as admin from "firebase-admin";
import { timingSafeEqual } from "crypto";
import {
  GateConfig, Session, World, Access, Role, ROLES, LINES, DEFAULT_MODEL, LOCKED_TURNS, UNLOCKED_TURNS,
  newSession, validateRequest, matchKey, cleanAccess, emptyAccess, checkWorld, checkSession,
  geminiRequest, parseGemini, left,
} from "./atlasGateLogic";

/**
 * atlasGate: the voice of Atlas behind ▶ run on noisysource.com (served at
 * /api/atlas through a Hosting rewrite, website target).
 *
 * A visitor who wakes Atlas gets a few replies from a real model (Gemini, on
 * a free-tier key), steered to find out who they are and why they came. If
 * they type the phrase the maker hands out, the door opens: more replies, and
 * Atlas may share what the maker put in `profile`. Every awakening is recorded
 * in atlas_awakenings/{session}, which the maker's own Atlas reads to tell him
 * someone came (that's the only link to the real Atlas: this function has no
 * tools and no private data).
 *
 * Cost safety (root CLAUDE.md, "Cost & Production Safety"): the key belongs
 * to a project with no billing, so Google can only refuse, never charge; on
 * top of that, 4 replies per visitor (20 after the phrase), one shared limit
 * for the whole web (49 messages, then 7 quiet hours: atlas_gate_usage/world),
 * one model call per message, no retries, a 12 s timeout, and maxInstances 3
 * (options.ts). Nothing is tracked per person: no IPs, no user agents.
 *
 * Config: atlas_gate/config (server-only; no client rule), see GateConfig.
 * Missing doc or `enabled: false` = Atlas stays asleep.
 *
 * Access: atlas_gate/access (see Access): knowledge blocks ("topics"), which
 * of them each role may hear ("roles"), and personal keys that open the door
 * as a given role. The shared `passphrase` opens it as Atlas's own guess.
 *
 * The maker panel (#maker on the site) sends `token` (= config.adminToken) to
 * read/save the access doc (`action: "access.get" | "access.set"`) and to talk
 * to Atlas as a role (`asRole`): such test sessions don't count towards the
 * world limit and are saved with `test: true, seen: true`.
 */

const CONFIG_DOC = "atlas_gate/config";
const SESSIONS = "atlas_awakenings";
const WORLD = "atlas_gate_usage/world";
const ACCESS_DOC = "atlas_gate/access";

function tokenOk(given: unknown, cfg: GateConfig): boolean {
  const want = cfg.adminToken ?? "";
  if (want.length < 24 || typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
const TIMEOUT_MS = 12_000;

async function askGemini(cfg: GateConfig, s: Session, message: string, access: Access) {
  const model = cfg.model || DEFAULT_MODEL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": cfg.geminiApiKey ?? "" },
      body: JSON.stringify(geminiRequest(s, cfg, message, access)),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn("atlasGate: Gemini refused", { status: res.status, body: (await res.text()).slice(0, 300) });
      return null;
    }
    return parseGemini(await res.json());
  } catch (e) {
    logger.warn("atlasGate: Gemini call failed", { error: String(e) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const atlasGate = onRequest({ invoker: "public", timeoutSeconds: 30, memory: "256MiB" }, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const db = admin.firestore();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const [cfgSnap, accessSnap] = await Promise.all([db.doc(CONFIG_DOC).get(), db.doc(ACCESS_DOC).get()]);
  const cfg = (cfgSnap.data() ?? {}) as GateConfig;
  const access = cleanAccess(accessSnap.data()) ?? emptyAccess();

  // The maker panel: read or save the access matrix.
  if (body.action === "access.get" || body.action === "access.set") {
    if (!tokenOk(body.token, cfg)) { res.status(403).json({ error: "no" }); return; }
    if (body.action === "access.get") { res.json({ access }); return; }
    const next = cleanAccess(body.access);
    if (!next) { res.status(400).json({ error: "bad access" }); return; }
    await db.doc(ACCESS_DOC).set({ ...next, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ access: next });
    return;
  }

  const input = validateRequest(body);
  if (!input) { res.status(400).json({ error: "bad request" }); return; }
  const asRole = (ROLES as readonly unknown[]).includes(body.asRole) ? (body.asRole as Role) : null;
  const testing = !!asRole && tokenOk(body.token, cfg);
  if (asRole && !testing) { res.status(403).json({ error: "no" }); return; }

  if (!cfgSnap.exists || cfg.enabled === false || !cfg.geminiApiKey) {
    res.json({ reply: LINES.asleep, state: "asleep", left: 0 });
    return;
  }

  const sessionRef = db.collection(SESSIONS).doc(input.session);
  const worldRef = db.doc(WORLD);
  const now = admin.firestore.FieldValue.serverTimestamp();

  // 1. Decide, in one transaction: asleep, over a limit, the phrase, or a
  //    normal turn (counted before the model is called, so failures count too).
  type Plan = { kind: "reply"; line: string; state: string; s: Session } | { kind: "ask"; s: Session };
  const plan: Plan = await db.runTransaction(async (tx) => {
    const [sSnap, wSnap] = await Promise.all([tx.get(sessionRef), tx.get(worldRef)]);
    const existing = sSnap.exists ? (sSnap.data() as Session) : null;
    const s: Session = existing ?? newSession();
    if (!existing) {
      if (testing) Object.assign(s, { unlocked: true, role: asRole, test: true });
      tx.set(sessionRef, {
        ...s, how: testing ? "maker" : input.how, ref: testing ? "" : input.ref,
        who: "unknown", why: "", seen: testing, createdAt: now, updatedAt: now,
      });
    }
    if (s.asleep) return { kind: "reply", line: LINES.asleep, state: "asleep", s };

    if (checkSession(s) === "session") {
      s.asleep = true;
      tx.set(sessionRef, { asleep: true, updatedAt: now, stoppedBy: "session" }, { merge: true });
      return { kind: "reply", line: s.unlocked ? LINES.unlockedDone : LINES.session, state: "asleep", s };
    }

    if (!s.test) {
      const world: World = { count: wSnap.get("count") ?? 0, quietUntil: wSnap.get("quietUntil") ?? 0 };
      const { quiet, next } = checkWorld(world, Date.now(), cfg);
      if (next !== world) tx.set(worldRef, next);
      if (quiet) {
        // Quiet for everyone: this visitor isn't put to sleep for good, they can come back.
        return { kind: "reply", line: LINES.quiet, state: "quiet", s };
      }
    }

    const key = s.unlocked ? null : matchKey(input.message, cfg, access);
    if (key) {
      s.unlocked = true;
      s.role = key.role;
      s.transcript.push({ from: "visitor", text: "[the phrase]" }, { from: "atlas", text: LINES.opened });
      tx.set(sessionRef, {
        unlocked: true, unlockedAt: now, updatedAt: now, transcript: s.transcript, seen: false,
        role: key.role, keyLabel: key.label,
      }, { merge: true });
      return { kind: "reply", line: LINES.opened, state: "open", s };
    }
    return { kind: "ask", s };
  });

  if (plan.kind === "reply") {
    res.json({ reply: plan.line, state: plan.state, left: plan.state === "awake" || plan.state === "open" ? left(plan.s) : 0 });
    return;
  }

  // 2. One model call. A failure costs the visitor the turn (no retry loops).
  const s = plan.s;
  const answer = await askGemini(cfg, s, input.message, access);
  const reply = answer?.reply ?? LINES.broken;
  if (s.unlocked) s.unlockedTurns += 1; else s.turns += 1;
  s.transcript.push({ from: "visitor", text: input.message }, { from: "atlas", text: reply });
  const done = s.unlocked ? s.unlockedTurns >= UNLOCKED_TURNS : s.turns >= LOCKED_TURNS;
  if (done) s.asleep = true;

  const update: Record<string, unknown> = {
    turns: s.turns, unlockedTurns: s.unlockedTurns, asleep: s.asleep,
    transcript: s.transcript, updatedAt: now, seen: !!s.test,
  };
  if (answer && answer.who !== "unknown") update.who = answer.who;
  if (answer?.why) update.why = answer.why;
  await sessionRef.set(update, { merge: true });

  res.json({ reply, state: s.asleep ? "asleep" : s.unlocked ? "open" : "awake", left: s.asleep ? 0 : left(s) });
});
