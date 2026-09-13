import { writeBatch, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { col, docRef } from '../lib/db';

function applyTokens(tpl: string, r: Record<string, any>) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = r[k];
    return v == null ? "" : String(v);
  });
}

type Audience = 'studyroom' | 'transport' | 'all';

const AUDIENCE_KIND: Record<Audience, string> = {
  studyroom: 'studyroom-manual',
  transport: 'transport-manual',
  all: 'all-manual',
};

const AUDIENCE_TAG: Record<Audience, string> = {
  studyroom: 'studyroom',
  transport: 'transport',
  all: 'all',
};

export const emailService = {
  async sendEmails(
    recipients: any[],
    subjectTpl: string,
    bodyTpl: string,
    statusFilter: string,
    search: string,
    audience: Audience = 'studyroom'
  ): Promise<number> {
    const campaignRef = await addDoc(col("emailCampaigns"), {
      kind: AUDIENCE_KIND[audience],
      audience,
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
      const docId = idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "_");
      const outRef = docRef("emailOutbox", docId);

      const toName = r.guardianName || r.nomes || r.studentName || "";
      const entityId = r.id.startsWith("transport:") ? r.email : r.id;
      const entityCollection = r.audience === "transport" ? "transportationSubscriptions" : "studyroom";

      batch.set(
        outRef,
        {
          status: "queued",
          to: r.email,
          toName,
          subject,
          html,
          text,
          tags: [AUDIENCE_TAG[audience], ...(r.status ? [`status:${r.status}`] : [])],
          entity: { collection: entityCollection, id: entityId },
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
