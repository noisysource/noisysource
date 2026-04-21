import Header from '../../components/Header';
import ClientSidebar from '../../components/client/ClientSidebar';
import { Outlet } from 'react-router-dom';

export default function ClientLayout() {
  return (
    <>
      <Header />
      <div className="min-h-screen flex">
        <ClientSidebar />
        <main className="flex-1 p-6 bg-gray-50">
          <Outlet />
        </main>
      </div>
    </>
  );
}
