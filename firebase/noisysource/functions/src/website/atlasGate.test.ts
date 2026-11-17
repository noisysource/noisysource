// atlasGate end to end, in-process: an in-memory Firestore stands in for the
// Admin SDK and a fake fetch for Gemini.
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------- an in-memory Firestore, just what atlasGate uses ----------
const store = new Map<string, Record<string, unknown>>();
const INC = Symbol("inc");
const TS = Symbol("ts");
function apply(path: string, data: Record<string, unknown>, merge: boolean) {
  const prev = merge ? { ...(store.get(path) ?? {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && INC in (v as object)) prev[k] = ((prev[k] as number) ?? 0) + (v as { [INC]: number })[INC];
    else if (v === TS) prev[k] = "now";
    else prev[k] = structuredClone(v);
  }
  store.set(path, prev);
}
const snap = (path: string) => {
  const d = store.get(path);
  return { exists: !!d, data: () => (d ? structuredClone(d) : undefined), get: (k: string) => d?.[k] };
};
const docRef = (path: string) => ({
  path,
  get: async () => snap(path),
  set: async (data: Record<string, unknown>, opt?: { merge?: boolean }) => apply(path, data, !!opt?.merge),
});
const firestore = () => ({
  doc: docRef,
  collection: (c: string) => ({ doc: (id: string) => docRef(`${c}/${id}`) }),
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
    const writes: [string, Record<string, unknown>, boolean][] = [];
    const out = await fn({
      get: async (r: { path: string }) => snap(r.path),
      set: (r: { path: string }, data: Record<string, unknown>, opt?: { merge?: boolean }) => writes.push([r.path, data, !!opt?.merge]),
    });
    for (const w of writes) apply(...w);
    return out;
  },
});
(firestore as unknown as Record<string, unknown>).FieldValue = {
  increment: (n: number) => ({ [INC]: n }),
  serverTimestamp: () => TS,
};
vi.mock("firebase-admin", () => ({ firestore, initializeApp: () => {} }));
vi.mock("firebase-functions/v2/https", () => ({ onRequest: (_o: unknown, h: unknown) => h }));
vi.mock("firebase-functions", () => ({ logger: { warn: () => {} } }));

// ---------- a fake Gemini ----------
let geminiCalls = 0;
let geminiReply: Record<string, string> | null = { reply: "and who sent you?", who: "investor", why: "looking to fund" };
vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
  geminiCalls++;
  const body = JSON.parse(init.body);
  lastPrompt = body.systemInstruction.parts[0].text;
  if (!geminiReply) return { ok: false, status: 429, text: async () => "quota" };
  return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiReply) }] } }] }) };
});
let lastPrompt = "";

const { atlasGate } = await import("./atlasGate");
const handler = atlasGate as unknown as (req: unknown, res: unknown) => Promise<void>;

async function say(session: string, message: string, ip = "1.2.3.4") {
  let out: Record<string, unknown> = {};
  let status = 200;
  const res = { set: () => res, status: (s: number) => { status = s; return res; }, json: (o: Record<string, unknown>) => { out = o; } };
  await handler({ method: "POST", body: { session, message, how: "star", ref: "https://linkedin.com" }, headers: { "x-forwarded-for": ip, "user-agent": "test" } }, res);
  return { status, ...out };
}

beforeEach(() => {
  store.clear();
  geminiCalls = 0;
  geminiReply = { reply: "and who sent you?", who: "investor", why: "looking to fund" };
  store.set("atlas_gate/config", { geminiApiKey: "k", passphrase: "Abre-te Sésamo", profile: "Renato builds Atlas." });
});

describe("atlasGate", () => {
  it("sleeps without a config, and never calls the model", async () => {
    store.clear();
    expect(await say("session-0001", "hello")).toMatchObject({ state: "asleep" });
    expect(geminiCalls).toBe(0);
  });

  it("talks four times, records who/why/how, then goes back to sleep", async () => {
    const replies = [];
    for (let i = 0; i < 4; i++) replies.push(await say("session-0001", `message ${i}`));
    expect(replies.map((r) => r.left)).toEqual([3, 2, 1, 0]);
    expect(replies[3].state).toBe("asleep");
    const rec = store.get("atlas_awakenings/session-0001")!;
    expect(rec).toMatchObject({ who: "investor", why: "looking to fund", how: "star", ref: "https://linkedin.com", turns: 4, asleep: true, seen: false });
    expect((rec.transcript as unknown[]).length).toBe(3 + 8); // the opening + 4 exchanges
    expect(await say("session-0001", "one more")).toMatchObject({ state: "asleep", left: 0 });
    expect(geminiCalls).toBe(4);
  });

  it("opens the door on the phrase, without asking the model, and keeps the phrase out of the record", async () => {
    await say("session-0002", "hi");
    const r = await say("session-0002", "ok: abre-te sesamo!");
    expect(r).toMatchObject({ state: "open" });
    expect(geminiCalls).toBe(1);
    const rec = store.get("atlas_awakenings/session-0002")!;
    expect(rec.unlocked).toBe(true);
    expect(JSON.stringify(rec)).not.toMatch(/sesamo/i);
    await say("session-0002", "tell me about him");
    expect(lastPrompt).toContain("Renato builds Atlas.");
  });

  it("never shows the model the profile while locked", async () => {
    await say("session-0003", "who is Renato?");
    expect(lastPrompt).not.toContain("Renato builds Atlas.");
    expect(lastPrompt).not.toMatch(/sesamo/i);
  });

  it("caps one IP across sessions and everyone per day", async () => {
    store.set("atlas_gate/config", { geminiApiKey: "k", passphrase: "x y z", perIpDaily: 3, dailyLimit: 5 });
    for (let i = 0; i < 3; i++) await say(`session-ip-${i}`, "hi", "9.9.9.9");
    expect(await say("session-ip-4", "hi", "9.9.9.9")).toMatchObject({ state: "asleep", reply: expect.stringContaining("enough for one day") });
    await say("session-b-1", "hi", "8.8.8.8");
    await say("session-b-2", "hi", "8.8.8.8");
    expect(await say("session-c-1", "hi", "7.7.7.7")).toMatchObject({ state: "asleep", reply: expect.stringContaining("too many") });
    expect(geminiCalls).toBe(5);
  });

  it("answers with a scripted line when Gemini fails, and the turn still counts", async () => {
    geminiReply = null;
    const r = await say("session-0004", "hello");
    expect(r).toMatchObject({ reply: expect.stringContaining("signal breaks"), left: 3 });
  });

  it("rejects bad requests", async () => {
    expect((await say("x", "hi")).status).toBe(400);
  });
});
