import { writeBatch, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { col, docRef } from '../lib/db';

const VARS = ["studentName", "guardianName", "status", "schoolName"] as const;
type Token = typeof VARS[number];

function applyTokens(tpl: string, r: any) {
  return tpl.replace(/\{\{\w+\}\}/g, (_, k: Token) => {
    const v = (r as any)[k];
    return v == null ? "" : String(v);
  });
}

export const emailService = {
  async sendEmails(recipients: any[], subjectTpl: string, bodyTpl: string, statusFilter: string, search: string): Promise<number> {
    const campaignRef = await addDoc(col("emailCampaigns"), {
      kind: "studyroom-manual",
      subjectTpl,
      bodyTpl,
      filter: { status: statusFilter || null, search: search || null },
      createdAt: serverTimestamp(),
      createdBy: "admin-ui",
      totalPlanned: recipients.length,
    });

    const batch = writeBatch(db);

    for (const r of recipients) {
      const subject = applyTokens(subjectTpl, r);
      const html = applyTokens(bodyTpl, r);
      const text = html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");

      const idempotencyKey = `${campaignRef.id}:${r.id}`;
      const docId = idempotencyKey.replace(/[:]/g, "_");
      const outRef = docRef("emailOutbox", docId);

      // use merge:true for idempotent retries (won’t duplicate)
      batch.set(
        outRef,
        {
          status: "queued",
          to: r.email,
          toName: r.guardianName || r.studentName,
          subject,
          html,
          text,
          tags: ["studyroom", `status:${r.status || "unknown"}`],
          entity: { collection: "studyroom", id: r.id },
          campaignId: campaignRef.id,
          idempotencyKey,
          createdAt: serverTimestamp(),
          createdBy: "admin-ui",
        },
        { merge: true }
      );
    }

    await batch.commit();
    return recipients.length;
  },
};
