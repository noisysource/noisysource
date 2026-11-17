import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import * as admin from "firebase-admin";
import { createHash } from "crypto";
import {
  GateConfig, Session, LINES, DEFAULT_MODEL, LOCKED_TURNS, UNLOCKED_TURNS,
  newSession, validateRequest, saysPhrase, checkLimits, geminiRequest, parseGemini, left,
} from "./atlasGateLogic";

/**
 * atlasGate: the voice of Atlas behind ▶ run on noisysource.com (served at
 * /api/atlas through a Hosting rewrite, website target).
 *
 * A visitor who wakes Atlas gets a few replies from a real model (Gemini, on
 * a free-tier key), steered to find out who they are and why they came. If
 * they type the phrase Renato hands out, the door opens: more replies, and
 * Atlas may share what Renato put in `profile`. Every awakening is recorded
 * in atlas_awakenings/{session}, which Renato's own Atlas reads to tell him
 * someone came (that's the only link to the real Atlas: this function has no
 * tools and no private data).
 *
 * Cost safety (root CLAUDE.md, "Cost & Production Safety"): the key belongs
 * to a project with no billing, so Google can only refuse, never charge; on
 * top of that, 4 replies per visitor (20 after the phrase), a per-IP and a
 * global daily cap counted in Firestore, one model call per message, no
 * retries, a 12 s timeout, and maxInstances 3 (options.ts).
 *
 * Config: atlas_gate/config (server-only; no client rule), see GateConfig.
 * Missing doc or `enabled: false` = Atlas stays asleep.
 */

const CONFIG_DOC = "atlas_gate/config";
const SESSIONS = "atlas_awakenings";
const USAGE = "atlas_gate_usage";
const TIMEOUT_MS = 12_000;

const day = () => new Date().toISOString().slice(0, 10);

function ipHash(req: { headers: Record<string, unknown>; ip?: string }): string {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  const ip = fwd || req.ip || "unknown";
  return createHash("sha256").update(`atlas|${process.env.GCLOUD_PROJECT}|${ip}`).digest("hex").slice(0, 16);
}

async function askGemini(cfg: GateConfig, s: Session, message: string) {
  const model = cfg.model || DEFAULT_MODEL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": cfg.geminiApiKey ?? "" },
      body: JSON.stringify(geminiRequest(s, cfg, message)),
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

  const input = validateRequest(req.body);
  if (!input) { res.status(400).json({ error: "bad request" }); return; }

  const db = admin.firestore();
  const cfgSnap = await db.doc(CONFIG_DOC).get();
  const cfg = (cfgSnap.data() ?? {}) as GateConfig;
  if (!cfgSnap.exists || cfg.enabled === false || !cfg.geminiApiKey) {
    res.json({ reply: LINES.asleep, state: "asleep", left: 0 });
    return;
  }

  const ip = ipHash(req);
  const today = day();
  const sessionRef = db.collection(SESSIONS).doc(input.session);
  const allRef = db.collection(USAGE).doc(today);
  const ipRef = db.collection(USAGE).doc(`${today}_${ip}`);
  const now = admin.firestore.FieldValue.serverTimestamp();

  // 1. Decide, in one transaction: asleep, over a limit, the phrase, or a
  //    normal turn (counted before the model is called, so failures count too).
  type Plan = { kind: "reply"; line: string; state: string; s: Session } | { kind: "ask"; s: Session };
  const plan: Plan = await db.runTransaction(async (tx) => {
    const [sSnap, allSnap, ipSnap] = await Promise.all([tx.get(sessionRef), tx.get(allRef), tx.get(ipRef)]);
    const existing = sSnap.exists ? (sSnap.data() as Session) : null;
    const s: Session = existing ?? newSession();
    if (!existing) {
      tx.set(sessionRef, {
        ...s, how: input.how, ref: input.ref, ipHash: ip,
        ua: String(req.headers["user-agent"] ?? "").slice(0, 200),
        who: "unknown", why: "", seen: false, createdAt: now, updatedAt: now,
      });
    }
    if (s.asleep) return { kind: "reply", line: LINES.asleep, state: "asleep", s };

    const limit = checkLimits(s, ipSnap.get("messages") ?? 0, allSnap.get("messages") ?? 0, cfg);
    if (limit !== "ok") {
      s.asleep = true;
      tx.set(sessionRef, { asleep: true, updatedAt: now, stoppedBy: limit }, { merge: true });
      const line = limit === "session" && s.unlocked ? LINES.unlockedDone : LINES[limit];
      return { kind: "reply", line, state: "asleep", s };
    }

    tx.set(allRef, { messages: admin.firestore.FieldValue.increment(1) }, { merge: true });
    tx.set(ipRef, { messages: admin.firestore.FieldValue.increment(1) }, { merge: true });

    if (!s.unlocked && saysPhrase(input.message, cfg.passphrase)) {
      s.unlocked = true;
      s.transcript.push({ from: "visitor", text: "[the phrase]" }, { from: "atlas", text: LINES.opened });
      tx.set(sessionRef, {
        unlocked: true, unlockedAt: now, updatedAt: now, transcript: s.transcript, seen: false,
      }, { merge: true });
      return { kind: "reply", line: LINES.opened, state: "open", s };
    }
    return { kind: "ask", s };
  });

  if (plan.kind === "reply") {
    res.json({ reply: plan.line, state: plan.state, left: plan.state === "asleep" ? 0 : left(plan.s) });
    return;
  }

  // 2. One model call. A failure costs the visitor the turn (no retry loops).
  const s = plan.s;
  const answer = await askGemini(cfg, s, input.message);
  const reply = answer?.reply ?? LINES.broken;
  if (s.unlocked) s.unlockedTurns += 1; else s.turns += 1;
  s.transcript.push({ from: "visitor", text: input.message }, { from: "atlas", text: reply });
  const done = s.unlocked ? s.unlockedTurns >= UNLOCKED_TURNS : s.turns >= LOCKED_TURNS;
  if (done) s.asleep = true;

  const update: Record<string, unknown> = {
    turns: s.turns, unlockedTurns: s.unlockedTurns, asleep: s.asleep,
    transcript: s.transcript, updatedAt: now, seen: false,
  };
  if (answer && answer.who !== "unknown") update.who = answer.who;
  if (answer?.why) update.why = answer.why;
  await sessionRef.set(update, { merge: true });

  res.json({ reply, state: s.asleep ? "asleep" : s.unlocked ? "open" : "awake", left: s.asleep ? 0 : left(s) });
});
