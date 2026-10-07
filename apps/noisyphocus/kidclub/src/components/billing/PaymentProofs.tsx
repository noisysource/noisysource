import { useRef, useState } from 'react';
import type { PaymentProof } from '@shared/models';
import { PROOF_ACCEPT, proofFileError, uploadPaymentProof, openPaymentProof } from '../../lib/paymentProof';

function fmtDate(ts: any): string {
  const d = ts?.toDate?.() ?? (ts ? new Date(ts) : null);
  return d ? d.toLocaleDateString('pt-PT') : '';
}

/** Already-uploaded proofs, each opening in a new tab (getDownloadURL on click). */
export function PaymentProofList({ proofs, showUploader = false }: { proofs: PaymentProof[] | undefined; showUploader?: boolean }) {
  const [error, setError] = useState('');
  if (!proofs?.length) return null;
  const open = async (p: PaymentProof) => {
    setError('');
    try { await openPaymentProof(p.path); }
    catch (e: any) { setError(e?.message ?? 'Não foi possível abrir o ficheiro.'); }
  };
  return (
    <div className="space-y-1">
      {proofs.map(p => (
        <div key={p.path} className="flex items-center gap-2 text-xs text-gray-600">
          <span aria-hidden>📎</span>
          <button type="button" onClick={() => open(p)} className="text-indigo-600 hover:underline truncate max-w-[16rem] text-left" title={p.fileName}>
            {p.fileName}
          </button>
          <span className="text-gray-400 shrink-0">
            {showUploader ? `${p.uploaderRole === 'admin' ? 'admin' : 'encarregado'} · ` : ''}{fmtDate(p.uploadedAt)}
          </span>
        </div>
      ))}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** "Enviar comprovativo" button: picks a file, uploads it, attaches it to the bill. */
export function PaymentProofUpload({ billingId, onUploaded, label = 'Enviar comprovativo', className }: {
  billingId: string;
  onUploaded: () => void;
  label?: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(''); setDone(false);
    const invalid = proofFileError(file);
    if (invalid) { setError(invalid); return; }
    setUploading(true);
    try {
      await uploadPaymentProof(billingId, file);
      setDone(true);
      onUploaded();
    } catch (e: any) {
      setError(e?.message ?? 'Falha ao enviar o comprovativo.');
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="space-y-1">
      <input ref={input} type="file" accept={PROOF_ACCEPT} className="hidden" onChange={e => onFile(e.target.files?.[0])} />
      <button type="button" onClick={() => input.current?.click()} disabled={uploading}
        className={className ?? 'inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-800 hover:underline disabled:opacity-50'}>
        <span aria-hidden>📎</span>{uploading ? 'A enviar...' : label}
      </button>
      <p className="text-[11px] text-gray-400">PDF ou imagem (JPEG, PNG, HEIC), até 10 MB.</p>
      {done && <p className="text-xs text-green-700">Comprovativo enviado.</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
