
import { useUser } from '@shared/hooks';
import { loginWithGoogle } from '@shared/firebase/auth';
import { useNavigate } from 'react-router-dom';

import { signOut } from 'firebase/auth';
import { auth, db } from '../lib/firebase';

export default function Header() {
  const user = useUser();
  const navigate = useNavigate();

  const handleLogin = async () => {
    try {
      await loginWithGoogle(auth, db);
    } catch (err) {
      alert('Login failed');
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  const handleGoTo = (destination: 'admin' | 'finhub') => {
    if (destination === 'admin') navigate('/admin');
    if (destination === 'finhub') window.location.href = 'http://localhost:5174'; // or your finhub route
  };

  return (
    <header className="p-4 bg-pink-100 flex justify-between items-center">
      <h1 className="text-lg font-bold">ArcoÍris da Pequenada</h1>

      {!user ? (
        <button onClick={handleLogin} className="bg-blue-500 text-white px-4 py-2 rounded">
          Login with Google
        </button>
      ) : (
        <div className="flex gap-4 items-center">
          <span className="text-sm">Hello, {user.name || user.email}</span>

          {user.roles.rainbowAdmin && (
            <button onClick={() => handleGoTo('admin')} className="bg-purple-500 text-white px-3 py-1 rounded">
              Go to Admin
            </button>
          )}
          {user.roles.finhubAdmin && (
            <button onClick={() => handleGoTo('finhub')} className="bg-green-500 text-white px-3 py-1 rounded">
              Go to Finhub
            </button>
          )}

          <button onClick={handleLogout} className="bg-gray-300 px-3 py-1 rounded">
            Logout
          </button>
        </div>
      )}
    </header>
  );
}