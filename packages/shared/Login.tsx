import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { loginWithGoogle, sendMagicLink, completeMagicLinkSignIn } from './firebase/auth';
import { useUser } from './hooks';

interface LoginPageProps {
  auth: Auth;
  db: Firestore;
  redirectTo?: string;
}

type Screen = 'idle' | 'email' | 'sent' | 'confirm_email';

export default function LoginPage({ auth, db, redirectTo = '/client' }: LoginPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useUser();
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>('idle');
  const [email, setEmail] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const destination = (location.state as { from?: string } | null)?.from ?? redirectTo;
  const redirectUrl = window.location.origin + '/login';

  // On mount: check if this page load is a magic link callback
  useEffect(() => {
    completeMagicLinkSignIn(auth, db, window.location.href)
      .then(({ completed, needsEmail }) => {
        if (needsEmail) {
          // Opened in a different browser — ask for email to complete
          setScreen('confirm_email');
          setLoading(false);
        } else if (!completed) {
          setLoading(false);
        }
        // if completed, onAuthStateChanged will fire and navigate away
      })
      .catch(() => {
        setError('Link inválido ou expirado. Tente novamente.');
        setLoading(false);
      });
  }, []);

  // Navigate once auth resolves
  useEffect(() => {
    if (user) {
      navigate(destination, { replace: true });
    } else if (user === null) {
      setLoading(false);
    }
  }, [user]);

  const handleSendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError('');
    try {
      await sendMagicLink(auth, email.trim(), redirectUrl);
      setScreen('sent');
    } catch {
      setError('Não foi possível enviar o link. Verifique o email e tente novamente.');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmEmail.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { completed } = await completeMagicLinkSignIn(auth, db, window.location.href, confirmEmail.trim());
      if (!completed) setError('Link inválido ou expirado. Tente pedir um novo link.');
    } catch {
      setError('Email incorreto ou link expirado. Tente novamente.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500 text-sm">A verificar sessão...</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-8 rounded-xl shadow-md max-w-sm w-full text-center space-y-6">
        <div>
          <h1 className="text-xl font-bold text-gray-800">Área de Clientes</h1>
          <p className="text-sm text-gray-500 mt-1">Arco-Íris da Pequenada</p>
        </div>

        {error && (
          <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {/* Magic link opened in different browser — ask for email */}
        {screen === 'confirm_email' && (
          <form onSubmit={handleConfirmEmail} className="space-y-3 text-left">
            <p className="text-sm text-gray-600 text-center">
              Confirme o seu email para completar o acesso.
            </p>
            <input
              type="email"
              required
              autoFocus
              placeholder="o-seu-email@exemplo.com"
              value={confirmEmail}
              onChange={e => setConfirmEmail(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {busy ? 'A verificar…' : 'Confirmar'}
            </button>
          </form>
        )}

        {/* Link sent confirmation */}
        {screen === 'sent' && (
          <div className="space-y-3">
            <div className="text-4xl">📬</div>
            <p className="text-sm text-gray-700">
              Link enviado para <strong>{email}</strong>.<br />
              Verifique o seu email e clique no link para entrar.
            </p>
            <button
              onClick={() => { setScreen('idle'); setError(''); }}
              className="text-sm text-blue-600 hover:underline"
            >
              Usar um email diferente
            </button>
          </div>
        )}

        {/* Email entry form */}
        {screen === 'email' && (
          <form onSubmit={handleSendLink} className="space-y-3 text-left">
            <label className="block text-sm text-gray-600">
              Email do encarregado de educação
            </label>
            <input
              type="email"
              required
              autoFocus
              placeholder="o-seu-email@exemplo.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {busy ? 'A enviar…' : 'Enviar link de acesso'}
            </button>
            <button
              type="button"
              onClick={() => { setScreen('idle'); setError(''); }}
              className="w-full text-sm text-gray-500 hover:text-gray-700"
            >
              Voltar
            </button>
          </form>
        )}

        {/* Default: choose login method */}
        {screen === 'idle' && (
          <div className="space-y-3">
            <button
              onClick={() =>
                loginWithGoogle(auth, db).catch(() =>
                  setError('Erro ao autenticar. Tente novamente.')
                )
              }
              className="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 text-gray-700 font-medium px-4 py-3 rounded-lg hover:bg-gray-50 transition shadow-sm"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Entrar com Google
            </button>

            <div className="flex items-center gap-3 text-xs text-gray-400">
              <div className="flex-1 h-px bg-gray-200" />
              ou
              <div className="flex-1 h-px bg-gray-200" />
            </div>

            <button
              onClick={() => { setScreen('email'); setError(''); }}
              className="w-full bg-blue-600 text-white font-medium px-4 py-3 rounded-lg hover:bg-blue-700 transition"
            >
              Entrar com email
            </button>
            <p className="text-xs text-gray-400">
              Receberá um link de acesso no seu email — sem necessidade de palavra-passe.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
