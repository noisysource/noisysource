import { useUser } from '@shared/hooks';
import { useNavigate, Link } from 'react-router-dom';
import { logout } from '@shared/firebase/auth';
import { auth } from '../lib/firebase';

interface HeaderProps {
  onMenuClick?: () => void;
}

export default function Header({ onMenuClick }: HeaderProps) {
  const user = useUser();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout(auth);
    navigate('/');
  };

  return (
    <header className="px-4 py-3 bg-pink-100 flex justify-between items-center border-b border-pink-200">
      <div className="flex items-center gap-3">
        {onMenuClick && (
          <button
            onClick={onMenuClick}
            className="md:hidden p-1 -ml-1 rounded text-pink-700 hover:bg-pink-200 transition-colors"
            aria-label="Abrir menu"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        <Link to="/" className="text-lg font-bold text-pink-700">Arco-Íris da Pequenada</Link>
      </div>

      {user ? (
        <div className="flex items-center gap-3">
          <span className="hidden sm:block text-sm text-gray-600 max-w-[160px] truncate">{user.name || user.email}</span>
          {user.roles?.rainbowAdmin && (
            <button
              onClick={() => navigate('/admin')}
              className="text-xs bg-purple-100 text-purple-700 border border-purple-200 px-3 py-1 rounded-lg hover:bg-purple-200"
            >
              Admin
            </button>
          )}
          <button
            onClick={handleLogout}
            className="text-xs bg-gray-100 text-gray-600 border border-gray-200 px-3 py-1 rounded-lg hover:bg-gray-200"
          >
            Sair
          </button>
        </div>
      ) : (
        <Link
          to="/login"
          className="text-sm font-medium text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50"
        >
          Entrar
        </Link>
      )}
    </header>
  );
}
