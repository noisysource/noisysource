import { useNavigate } from 'react-router-dom';
import { auth } from '../lib/firebase';
import { logout } from '@shared/firebase/auth';

export default function NotAuthorized() {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout(auth);
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex flex-col items-center justify-center h-screen text-center gap-4">
      <h1 className="text-2xl font-bold">Acesso negado</h1>
      <p className="text-gray-500">Não tem permissão para aceder a esta página.</p>
      <button
        onClick={handleLogout}
        className="mt-2 px-4 py-2 bg-gray-800 text-white rounded-lg text-sm hover:bg-gray-700 transition"
      >
        Sair e tentar com outra conta
      </button>
    </div>
  );
}
