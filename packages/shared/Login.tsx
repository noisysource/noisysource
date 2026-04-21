
import { useNavigate } from 'react-router-dom';
import { Auth } from 'firebase/auth';
import { Firestore } from 'firebase/firestore';
import { loginWithGoogle } from './firebase/auth';

interface LoginPageProps {
  auth: Auth;
  db: Firestore;
  appName?: string;
}

export default function LoginPage({ auth, db }: LoginPageProps) {
  const navigate = useNavigate();

  const handleLogin = async () => {
    try {
      await loginWithGoogle(auth, db);
      navigate('/');
    } catch (err) {
      alert('❌ Login failed');
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-6 rounded-lg shadow max-w-sm w-full text-center space-y-4">
        <h1 className="text-xl font-bold text-gray-800">
          Login
        </h1>
        <button
          onClick={handleLogin}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 w-full"
        >
          Sign in with Google
        </button>
      </div>
    </div>
  );
}