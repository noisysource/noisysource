import Header from '../../components/Header';
import Sidebar from '../../components/admin/Sidebar';
import { Outlet } from 'react-router-dom';

export default function AdminLayout() {
  return (
    <>
      <Header />
      <div className="min-h-screen flex">
        <Sidebar />
        <main className="flex-1 p-6 bg-pink-50">
          <Outlet />
        </main>
      </div>
    </>
  );
}
