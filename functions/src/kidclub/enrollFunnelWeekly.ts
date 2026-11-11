import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { appCol } from "./db";
import { ADMIN_EMAIL } from "./notifications";
import {
  AuthAccount, ChildRow, Counted, FamilyRow, FormEventRow, RequestRow, Service, SubscriptionRow,
  NO_SUBSCRIPTION_WINDOW_DAYS, WINDOW_DAYS, buildFunnelEmail, countChildrenAdded,
  countNewAccounts, countProfilesCompleted, countWithoutSubscription, familiesWithRecentChild,
  hasStaffRole, summarizeForms, summarizeRequests,
} from "./enrollFunnelWeeklyLogic";

const ADMIN_URL = "https://kidclub.pt/admin/subscriptions";
const DAY_MS = 86_400_000;

// One run stays cheap whatever the volume. KidClub has ~40 families; these only
// bite if something is badly wrong, and the email marks a capped number with "+".
const AUTH_PAGE_SIZE = 1000;
const AUTH_MAX_PAGES = 10;
const REQUESTS_LIMIT = 100; // newest per service; also answers "when was the last one"
const FAMILIES_LIMIT = 500;
const CHILDREN_LIMIT = 500;
const EVENTS_LIMIT = 2000;
const FAMILIES_CHECKED_LIMIT = 300;
const SUBSCRIPTIONS_PER_QUERY = 500;
const STAFF_LOOKUP_LIMIT = 1000;
const IN_QUERY_SIZE = 30; // Firestore's limit for "in"

/** One failed read shows as "indisponível" in the email rather than stopping it: the email must always arrive. */
async function guarded<T>(label: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`[enrollFunnelWeekly] ${label} read failed`, err);
    return null;
  }
}

async function recentAccounts(since: Date): Promise<{ rows: AuthAccount[]; capped: boolean }> {
  const rows: AuthAccount[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await admin.auth().listUsers(AUTH_PAGE_SIZE, pageToken);
    for (const u of page.users) {
      const createdAt = new Date(u.metadata.creationTime);
      if (createdAt >= since) rows.push({ uid: u.uid, email: u.email, createdAt });
    }
    pageToken = page.pageToken;
    pages++;
  } while (pageToken && pages < AUTH_MAX_PAGES);
  return { rows, capped: !!pageToken };
}

async function createdSince<T>(collection: string, since: Date, limit: number, fields: string[]) {
  const snap = await appCol(collection)
    .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(since))
    .orderBy("createdAt", "desc")
    .limit(limit)
    .select(...fields)
    .get();
  return { rows: snap.docs.map(d => d.data() as T), limitHit: snap.size === limit };
}

// A range on createdAt, not a bare orderBy: a desc orderBy puts any non-Timestamp
// value (old imported docs) first, and those would crowd out the real newest ones.
// Docs with no createdAt aren't returned either way.
async function newestRequests(collection: string) {
  const snap = await appCol(collection)
    .where("createdAt", ">", admin.firestore.Timestamp.fromMillis(0))
    .orderBy("createdAt", "desc")
    .limit(REQUESTS_LIMIT)
    .select("createdAt", "source", "userId")
    .get();
  return { rows: snap.docs.map(d => d.data() as RequestRow), limitHit: snap.size === REQUESTS_LIMIT };
}

async function staffAmong(uids: Set<string>): Promise<Set<string>> {
  const db = admin.firestore();
  const refs = [...uids].filter(Boolean).slice(0, STAFF_LOOKUP_LIMIT).map(uid => db.collection("users").doc(uid));
  if (refs.length === 0) return new Set();
  const snaps = await db.getAll(...refs, { fieldMask: ["roles"] });
  return new Set(snaps.filter(s => hasStaffRole(s.get("roles"))).map(s => s.id));
}

async function subscriptionsOf(familyIds: string[]): Promise<SubscriptionRow[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < familyIds.length; i += IN_QUERY_SIZE) chunks.push(familyIds.slice(i, i + IN_QUERY_SIZE));
  const snaps = await Promise.all(chunks.flatMap(chunk =>
    ["studyroom", "transportationSubscriptions"].map(name =>
      appCol(name)
        .where("familyId", "in", chunk)
        .limit(SUBSCRIPTIONS_PER_QUERY)
        .select("familyId", "status", "canceled")
        .get())));
  return snaps.flatMap(s => s.docs.map(d => d.data() as SubscriptionRow));
}

// Weekly email to the admin with the enrollment funnel. Sent every Monday even
// when every number is 0: for 7 weeks in 2026 no parent could enroll and nothing
// said so, because a disabled button throws no error and clientErrorsDigest stays
// silent on a quiet day. Logic and email text: enrollFunnelWeeklyLogic.ts.
export const enrollFunnelWeekly = onSchedule(
  { schedule: "0 8 * * 1", timeZone: "Europe/Lisbon", region: "europe-west3" },
  async () => {
    const now = new Date();
    const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
    const since30 = new Date(now.getTime() - NO_SUBSCRIPTION_WINDOW_DAYS * DAY_MS);

    const [accounts, families, children, requests, events] = await Promise.all([
      guarded("accounts", () => recentAccounts(since)),
      guarded("families", () => createdSince<FamilyRow>(
        "families", since, FAMILIES_LIMIT, ["createdAt", "profileComplete", "primaryContact.userId"])),
      guarded("children", () => createdSince<ChildRow>(
        "children", since30, CHILDREN_LIMIT, ["createdAt", "familyId", "userId", "status"])),
      guarded("requests", async () => {
        const [study, transport] = await Promise.all([
          newestRequests("studyroom"), newestRequests("transportationSubscriptions"),
        ]);
        return { study, transport } as Record<Service, { rows: RequestRow[]; limitHit: boolean }>;
      }),
      guarded("events", () => createdSince<FormEventRow>(
        "clientEvents", since, EVENTS_LIMIT, ["userId", "impersonatingFamilyId", "event", "service", "data"])),
    ]);

    const warnings: string[] = [];
    const uids = new Set<string>([
      ...(accounts?.rows ?? []).map(a => a.uid),
      ...(families?.rows ?? []).map(f => f.primaryContact?.userId ?? ""),
      ...(children?.rows ?? []).map(c => c.userId ?? ""),
      ...(events?.rows ?? []).map(e => e.userId ?? ""),
      ...(requests ? [...requests.study.rows, ...requests.transport.rows] : []).map(r => r.userId ?? ""),
    ]);
    let staff = await guarded("staff", () => staffAmong(uids));
    if (!staff) {
      staff = new Set();
      warnings.push("Não foi possível ler os perfis da equipa: os números abaixo podem incluir contas da equipa.");
    }

    let familiesWithoutSubscription: Counted | null = null;
    if (children) {
      const ids = familiesWithRecentChild(children.rows, staff, now);
      const checked = ids.slice(0, FAMILIES_CHECKED_LIMIT);
      const subscriptions = await guarded("subscriptions", () => subscriptionsOf(checked));
      if (subscriptions) {
        familiesWithoutSubscription = {
          count: countWithoutSubscription(checked, subscriptions),
          capped: children.limitHit || ids.length > checked.length,
        };
      }
    }

    const email = buildFunnelEmail({
      now,
      requests: requests ? summarizeRequests(requests, staff, now) : null,
      newAccounts: accounts ? countNewAccounts(accounts.rows, staff, ADMIN_EMAIL, now, accounts.capped) : null,
      profilesCompleted: families ? countProfilesCompleted(families.rows, staff, now, families.limitHit) : null,
      childrenAdded: children ? countChildrenAdded(children.rows, staff, now, children.limitHit) : null,
      forms: events ? { byService: summarizeForms(events.rows, staff), capped: events.limitHit } : null,
      familiesWithoutSubscription,
      adminUrl: ADMIN_URL,
      warnings,
    });

    console.log(`[enrollFunnelWeekly] emailing: ${email.subject}`);
    await appCol("emailOutbox").add({
      to: ADMIN_EMAIL,
      subject: email.subject,
      html: email.html,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  },
);
