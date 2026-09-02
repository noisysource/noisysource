import Header from '../../components/Header';
import Sidebar from '../../components/admin/Sidebar';
import { Outlet } from 'react-router-dom';

export default function AdminLayout() {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Header />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 min-h-0 overflow-y-auto p-6 bg-pink-50">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
