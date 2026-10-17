import { useEffect } from 'react';
import { AlertCircle, X } from 'lucide-react';

export interface Notice {
  /** Changes on every notice, so a repeat of the same text restarts the timer. */
  id: number;
  text: string;
}

const SHOW_MS = 7000;

/**
 * A short message along the bottom of the screen, above whichever screen is up.
 *
 * Exists because commands fail silently otherwise: a light that was refused
 * simply flips back, and from the sofa that looks like the app ignoring you.
 */
export default function NoticeToast({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  useEffect(() => {
    const id = setTimeout(onClose, SHOW_MS);
    return () => clearTimeout(id);
  }, [notice.id, onClose]);

  return (
    <div
      role="status"
      className="fixed left-1/2 -translate-x-1/2 z-[100] w-[min(28rem,calc(100vw-2rem))] flex items-start gap-3 rounded-xl bg-zinc-800 border border-zinc-700 shadow-2xl shadow-black/60 px-4 py-3 text-sm text-zinc-100"
      style={{ bottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <AlertCircle size={18} className="text-amber-400 shrink-0 mt-px" />
      <p className="flex-1 min-w-0 leading-snug">{notice.text}</p>
      <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 shrink-0" aria-label="Fechar">
        <X size={16} />
      </button>
    </div>
  );
}
