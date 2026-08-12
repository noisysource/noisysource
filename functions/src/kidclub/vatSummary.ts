import { onCall } from "firebase-functions/v2/https";
import { listDocuments, getDocumentFull } from "./vendus";

const BATCH_SIZE = 20;

async function batchedDetails(ids: number[]) {
  const results: Awaited<ReturnType<typeof getDocumentFull>>[] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const resolved = await Promise.all(batch.map(id => getDocumentFull(id)));
    results.push(...resolved);
  }
  return results;
}

export const getKidclubVatSummary = onCall(
  {
    region: "europe-west3",
    secrets: ["VENDUS_API_KEY", "VENDUS_REGISTER_ID"],
  },
  async (req) => {
    const { year, quarter } = req.data as { year: number; quarter: number };

    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth   = startMonth + 2;
    const dateFrom   = `${year}-${String(startMonth).padStart(2, "0")}-01`;
    const lastDay    = new Date(year, endMonth, 0).getDate();
    const dateTo     = `${year}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const docs = await listDocuments(dateFrom, dateTo);
    console.log(`[vatSummary] Q${quarter}/${year}: ${docs.length} documents found`);

    const details = await batchedDetails(docs.map(d => d.id));

    // Aggregate base and IVA by tax rate
    const byRate: Record<number, { baseCents: number; ivaCents: number }> = {};

    for (const doc of details) {
      if (!doc.taxes?.length) {
        // No taxes array — log for debugging and skip
        console.warn(`[vatSummary] doc ${doc.id} has no taxes array:`, JSON.stringify(doc).slice(0, 200));
        continue;
      }
      for (const tax of doc.taxes) {
        const rate = Number(tax.value);
        if (!byRate[rate]) byRate[rate] = { baseCents: 0, ivaCents: 0 };
        byRate[rate].baseCents += Math.round(parseFloat(tax.incidence) * 100);
        byRate[rate].ivaCents  += Math.round(parseFloat(tax.total) * 100);
      }
    }

    return { year, quarter, dateFrom, dateTo, docCount: docs.length, byRate };
  }
);
