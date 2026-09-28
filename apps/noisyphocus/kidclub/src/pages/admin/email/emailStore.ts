import {
  addDoc, deleteDoc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch, doc,
} from 'firebase/firestore';
import { db } from '../../../lib/firebase';
import { col, docRef } from '../../../lib/db';
import { toDate } from '../subscriptions/model';
import { AudienceFilters, Recipient } from './audience';
import { renderBody, renderSubject, wrapEmailHtml, htmlToText, VariableValues } from './variables';

/**
 * Firestore for the email composer.
 *
 * - emailTemplates/{id}  saved messages (name, subject, body).
 * - emailCampaigns/{id}  one per send: the template as written, the audience
 *                        filters, who sent it.
 * - emailOutbox/{id}     one per email, rendered, exactly as sent. Creating a
 *                        doc is what sends it (sendEmailFromOutbox trigger), so
 *                        a resend is a new doc, never an edit of the old one.
 */

/** Hard cap per send. The sender also caps the daily total (SendEmailFromOutbox.ts). */
export const MAX_RECIPIENTS_PER_SEND = 200;

export interface EmailTemplate { id: string; name: string; subject: string; body: string; updatedAt?: Date }

export interface Campaign {
  id: string;
  kind?: string;
  subjectTpl: string;
  bodyTpl: string;
  audience?: AudienceFilters;
  totalPlanned?: number;
  createdAt?: Date;
  createdBy?: string;
}

export interface OutboxEmail {
  id: string;
  to: string;
  toName?: string;
  subject: string;
  html?: string;
  text?: string;
  status: string;
  error?: string;
  familyKey?: string;
  familyId?: string;
  campaignId?: string;
  resendOf?: string;
  createdAt?: Date;
  sentAt?: Date;
}

// ─── Templates ───────────────────────────────────────────────────────────────

export async function listTemplates(): Promise<EmailTemplate[]> {
  const snap = await getDocs(col('emailTemplates'));
  return snap.docs
    .map(d => ({ id: d.id, ...(d.data() as any), updatedAt: d.data().updatedAt ? toDate(d.data().updatedAt) : undefined }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt'));
}

export async function saveTemplate(t: { id?: string; name: string; subject: string; body: string }, by: string): Promise<string> {
  const data = { name: t.name, subject: t.subject, body: t.body, updatedAt: serverTimestamp(), updatedBy: by };
  if (t.id) { await setDoc(docRef('emailTemplates', t.id), data, { merge: true }); return t.id; }
  return (await addDoc(col('emailTemplates'), { ...data, createdAt: serverTimestamp() })).id;
}

export async function deleteTemplate(id: string): Promise<void> {
  await deleteDoc(docRef('emailTemplates', id));
}

// ─── Sending ─────────────────────────────────────────────────────────────────

const safeId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

function renderFor(subjectTpl: string, bodyTpl: string, values: VariableValues) {
  const html = wrapEmailHtml(renderBody(bodyTpl, values));
  return { subject: renderSubject(subjectTpl, values), html, text: htmlToText(html) };
}

/** One email to the admin, rendered for one recipient, marked as a test. */
export async function sendTest(to: string, subjectTpl: string, bodyTpl: string, sample: Recipient, by: string) {
  const r = renderFor(subjectTpl, bodyTpl, sample.values);
  await addDoc(col('emailOutbox'), {
    status: 'queued', to, toName: '',
    subject: `[TESTE — ${sample.label}] ${r.subject}`, html: r.html, text: r.text,
    tags: ['composer-test'], createdAt: serverTimestamp(), createdBy: by,
  });
}

export async function sendCampaign(
  subjectTpl: string, bodyTpl: string, audience: AudienceFilters, recipients: Recipient[], by: string,
): Promise<string> {
  const targets = recipients.filter(r => r.email);
  if (targets.length === 0) throw new Error('Nenhum destinatário com email.');
  if (targets.length > MAX_RECIPIENTS_PER_SEND) {
    throw new Error(`Máximo ${MAX_RECIPIENTS_PER_SEND} destinatários por envio (tem ${targets.length}).`);
  }

  const campaign = await addDoc(col('emailCampaigns'), {
    kind: 'composer', subjectTpl, bodyTpl, audience,
    totalPlanned: targets.length, createdAt: serverTimestamp(), createdBy: by,
  });

  const batch = writeBatch(db);
  for (const r of targets) {
    const rendered = renderFor(subjectTpl, bodyTpl, r.values);
    batch.set(docRef('emailOutbox', safeId(`${campaign.id}_${r.familyKey}`)), {
      status: 'queued', to: r.email, toName: r.label, ...rendered,
      campaignId: campaign.id, familyKey: r.familyKey, familyId: r.familyId ?? null,
      tags: ['composer'], createdAt: serverTimestamp(), createdBy: by,
    });
  }
  await batch.commit();
  return campaign.id;
}

// ─── History ─────────────────────────────────────────────────────────────────

export async function listCampaigns(max = 50): Promise<Campaign[]> {
  const snap = await getDocs(query(col('emailCampaigns'), orderBy('createdAt', 'desc'), limit(max)));
  return snap.docs.map(d => {
    const x = d.data() as any;
    return { id: d.id, ...x, createdAt: x.createdAt ? toDate(x.createdAt) : undefined };
  });
}

const toOutbox = (id: string, x: any): OutboxEmail => ({
  ...x, id,
  createdAt: x.createdAt ? toDate(x.createdAt) : undefined,
  sentAt: x.sentAt ? toDate(x.sentAt) : undefined,
});

export async function listCampaignEmails(campaignId: string): Promise<OutboxEmail[]> {
  const snap = await getDocs(query(col('emailOutbox'), where('campaignId', '==', campaignId)));
  return snap.docs.map(d => toOutbox(d.id, d.data()));
}

/**
 * A family's latest attempt only: a resend supersedes the attempt it copies,
 * so the history shows one line per recipient.
 */
export function latestPerRecipient(emails: OutboxEmail[]): OutboxEmail[] {
  const byKey = new Map<string, OutboxEmail>();
  for (const e of emails) {
    const k = e.familyKey ?? e.to;
    const cur = byKey.get(k);
    if (!cur || (e.createdAt?.getTime() ?? 0) > (cur.createdAt?.getTime() ?? 0)) byKey.set(k, e);
  }
  return Array.from(byKey.values()).sort((a, b) => (a.toName ?? a.to).localeCompare(b.toName ?? b.to, 'pt'));
}

/** Same content, same recipient, as a new outbox doc (which sends it). */
export async function resend(emails: OutboxEmail[], by: string): Promise<void> {
  const batch = writeBatch(db);
  for (const e of emails) {
    const ref = doc(col('emailOutbox'), safeId(`${e.id.replace(/_r\d+$/, '')}_r${Date.now()}`));
    batch.set(ref, {
      status: 'queued', to: e.to, toName: e.toName ?? '',
      subject: e.subject, html: e.html ?? null, text: e.text ?? null,
      campaignId: e.campaignId ?? null, familyKey: e.familyKey ?? null, familyId: e.familyId ?? null,
      resendOf: e.id, tags: ['composer', 'resend'], createdAt: serverTimestamp(), createdBy: by,
    });
  }
  await batch.commit();
}

/** Mark an email that will never be sent (e.g. stale) so it stops showing as failed. */
export async function markSkipped(id: string, by: string): Promise<void> {
  await updateDoc(docRef('emailOutbox', id), { status: 'skipped', skippedBy: by, skippedAt: serverTimestamp() });
}
