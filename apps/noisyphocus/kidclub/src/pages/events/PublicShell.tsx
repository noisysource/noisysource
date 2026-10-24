import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useUser } from '@shared/hooks';

/** Frame of the public event pages (/eventos...): no login needed, same look as the landing page. */
export default function PublicShell({ children, back }: { children: ReactNode; back?: { to: string; label: string } }) {
  const user = useUser();
  return (
    <div className="font-fredoka min-h-screen bg-gradient-to-b from-pink-50 to-white text-gray-800">
      <header className="flex items-center justify-between gap-3 px-4 py-3 max-w-3xl mx-auto">
        <Link to="/" className="flex items-center gap-2 min-w-0">
          <img src="/logo.png" alt="" className="h-9 w-9 object-contain shrink-0" />
          <span className="font-bold text-pink-600 truncate">Arco-Íris da Pequenada</span>
        </Link>
        <Link
          to={user ? '/client' : '/login'}
          className="shrink-0 text-sm font-medium text-blue-600 hover:text-blue-800 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50 transition"
        >
          {user ? 'A minha área' : 'Área de Clientes'}
        </Link>
      </header>
      <main className="max-w-3xl mx-auto px-4 pb-16">
        {back && (
          <Link to={back.to} className="inline-block text-sm text-gray-500 hover:text-gray-700 mb-3">← {back.label}</Link>
        )}
        {children}
      </main>
    </div>
  );
}
