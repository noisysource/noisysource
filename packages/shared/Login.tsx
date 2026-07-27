import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { loginWithGoogle, handleGoogleRedirectResult } from './firebase/auth';
import { useUser } from './hooks';

interface LoginPageProps {
  auth: Auth;
  db: Firestore;
  redirectTo?: string;
}

export default function LoginPage({ auth, db, redirectTo = '/client' }: LoginPageProps) {
  const navigate = useNavigate();
  const user = useUser();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Handle returning from Google redirect
  useEffect(() => {
    handleGoogleRedirectResult(auth, db)
      .catch(() => setError('Erro ao autenticar. Tente novamente.'))
      .finally(() => setLoading(false));
  }, []);

  // Navigate once auth state resolves
  useEffect(() => {
    if (user) {
      navigate(redirectTo, { replace: true });
    } else if (user === null) {
      setLoading(false);
    }
  }, [user]);

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

        <button
          onClick={() => loginWithGoogle(auth, db).catch(() => setError('Erro ao autenticar. Tente novamente.'))}
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
      </div>
    </div>
  );
}
