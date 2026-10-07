import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from './firebase';
import { callable } from './callable';

/**
 * Proof of payment (e.g. a bank transfer receipt), optional, uploaded by the
 * parent or an admin. The file goes straight to Storage (storage.rules checks
 * ownership, type and size), then attachPaymentProof records it on the bill —
 * billing docs are not client-writable. Uploading never marks a bill paid.
 */

export const PROOF_MAX_BYTES = 10 * 1024 * 1024;
export const PROOF_ACCEPT = 'application/pdf,image/jpeg,image/png,image/heic,image/heif,.pdf,.jpg,.jpeg,.png,.heic,.heif';

const TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif',
};
const ALLOWED_TYPES = new Set(Object.values(TYPE_BY_EXTENSION));

/** Some browsers report HEIC (and occasionally PDF) with an empty type; fall back to the extension. */
function contentTypeOf(file: File): string | null {
  if (ALLOWED_TYPES.has(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return TYPE_BY_EXTENSION[ext] ?? null;
}

/** Returns a Portuguese error message, or null if the file can be uploaded. */
export function proofFileError(file: File): string | null {
  if (!contentTypeOf(file)) return 'Formato não suportado. Envie um PDF ou uma imagem (JPEG, PNG ou HEIC).';
  if (file.size > PROOF_MAX_BYTES) return 'O ficheiro é demasiado grande (máximo 10 MB).';
  return null;
}

function safeName(name: string): string {
  const cleaned = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || 'comprovativo').slice(-80);
}

export async function uploadPaymentProof(billingId: string, file: File): Promise<void> {
  const err = proofFileError(file);
  if (err) throw new Error(err);
  const path = `_apps/arcoiris/billing/${billingId}/proofs/${Date.now()}-${safeName(file.name)}`;
  try {
    await uploadBytes(ref(storage, path), file, { contentType: contentTypeOf(file)! });
  } catch (e: any) {
    console.error('[paymentProof] upload failed', e);
    throw new Error(e?.code === 'storage/unauthorized'
      ? 'Não foi possível enviar o comprovativo para esta mensalidade.'
      : 'Falha ao enviar o ficheiro. Tente novamente.');
  }
  await callable<{ billingId: string; path: string; fileName: string }, { ok: boolean }>('attachPaymentProof')({ billingId, path, fileName: file.name });
}

export async function openPaymentProof(path: string): Promise<void> {
  // Open the tab synchronously (popup blockers), then point it at the URL.
  const win = window.open('', '_blank');
  try {
    const url = await getDownloadURL(ref(storage, path));
    if (win) win.location.href = url; else window.location.href = url;
  } catch (e) {
    win?.close();
    throw e;
  }
}
