import { useState } from 'react';
import { House, LogIn } from 'lucide-react';
import { describeSignInError } from '../lib/auth';

/**
 * Shown instead of the house when the app is served from the public internet
 * and nobody is signed in.
 *
 * The Firestore rules are what actually protect the heating; this only stops a
 * stranger who finds the URL from seeing the layout of the house and its rooms.
 */
export function SignInScreen({ onSignIn }: { onSignIn: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function attempt() {
    setBusy(true);
    setError(null);
    try {
      await onSignIn();
    } catch (err) {
      setError(describeSignInError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-zinc-900 border border-zinc-800 mb-5">
          <House size={24} strokeWidth={1.75} className="text-zinc-400" />
        </div>
        <h1 className="text-xl font-medium tracking-tight">Domótica</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Esta página está acessível a partir da internet. Inicie sessão para
          controlar a casa.
        </p>

        <button
          onClick={() => void attempt()}
          disabled={busy}
          className="mt-6 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-50 transition-colors text-sm font-medium"
        >
          <LogIn size={16} strokeWidth={2} />
          {busy ? 'A entrar…' : 'Entrar com Google'}
        </button>

        {error && (
          <p className="mt-4 text-xs text-red-400 leading-relaxed">{error}</p>
        )}

        <p className="mt-8 text-xs text-zinc-600 leading-relaxed">
          Em casa, na rede local, a aplicação funciona sem sessão iniciada — o
          controlo da casa não depende da Google.
        </p>
      </div>
    </div>
  );
}
