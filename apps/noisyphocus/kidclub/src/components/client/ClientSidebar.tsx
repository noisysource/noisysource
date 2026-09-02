import { Link, useLocation } from 'react-router-dom';

export default function ClientSidebar() {
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  const linkClass = (path: string) => {
    const base = 'flex items-center gap-2 py-2 px-3 rounded-lg transition-colors text-sm';
    return isActive(path)
      ? `${base} bg-blue-600 text-white font-medium`
      : `${base} text-gray-300 hover:bg-gray-700`;
  };

  return (
    <aside className="w-56 bg-gray-800 text-white flex flex-col p-4 shrink-0">
      <div className="mb-6">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Área de Família</h2>
      </div>
      <nav className="space-y-1 flex-1">
        <Link to="/client" className={linkClass('/client')}>
          <span>🏠</span> Dashboard
        </Link>

        <div className="pt-3 pb-1">
          <p className="text-xs text-gray-500 uppercase tracking-wider px-3">Crianças</p>
        </div>
        <Link to="/client/children" className={linkClass('/client/children')}>
          <span>👧</span> As minhas crianças
        </Link>

        <Link to="/client/parties" className={linkClass('/client/parties')}>
          <span>🎈</span> Festas
        </Link>

        <Link to="/client/camps" className={linkClass('/client/camps')}>
          <span>🏕️</span> Campos
        </Link>

        <div className="pt-3 pb-1">
          <p className="text-xs text-gray-500 uppercase tracking-wider px-3">Financeiro</p>
        </div>
        <Link to="/client/invoices" className={linkClass('/client/invoices')}>
          <span>🧾</span> Faturas
        </Link>
        <Link to="/client/payments" className={linkClass('/client/payments')}>
          <span>💳</span> Pagamentos
        </Link>

        <div className="pt-3 pb-1">
          <p className="text-xs text-gray-500 uppercase tracking-wider px-3">Conta</p>
        </div>
        <Link to="/client/account" className={linkClass('/client/account')}>
          <span>👤</span> A minha conta
        </Link>
      </nav>
    </aside>
  );
}
