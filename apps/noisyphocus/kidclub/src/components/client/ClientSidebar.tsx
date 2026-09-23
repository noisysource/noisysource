import { Link, useLocation } from 'react-router-dom';

interface ClientSidebarProps {
  open: boolean;
  onClose: () => void;
}

export default function ClientSidebar({ open, onClose }: ClientSidebarProps) {
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  const linkClass = (path: string) => {
    const base = 'flex items-center gap-2 py-2 px-3 rounded-lg transition-colors text-sm';
    return isActive(path)
      ? `${base} bg-blue-600 text-white font-medium`
      : `${base} text-gray-300 hover:bg-gray-700`;
  };

  const navLinks = (onClick?: () => void) => (
    <nav className="space-y-1 flex-1">
      <Link to="/client" onClick={onClick} className={linkClass('/client')}>
        <span>🏠</span> Dashboard
      </Link>
      {/* Second in the list, not buried under a child: cancelling a day is the
          most frequent thing a parent comes here to do, and it used to take
          four screens. */}
      <Link to="/client/calendar" onClick={onClick} className={linkClass('/client/calendar')}>
        <span>📅</span> Calendário
      </Link>

      <div className="pt-3 pb-1">
        <p className="text-xs text-gray-500 uppercase tracking-wider px-3">Crianças</p>
      </div>
      <Link to="/client/children" onClick={onClick} className={linkClass('/client/children')}>
        <span>👧</span> As minhas crianças
      </Link>
      <Link to="/client/parties" onClick={onClick} className={linkClass('/client/parties')}>
        <span>🎈</span> Festas
      </Link>
      <Link to="/client/camps" onClick={onClick} className={linkClass('/client/camps')}>
        <span>🏕️</span> Campos
      </Link>

      <div className="pt-3 pb-1">
        <p className="text-xs text-gray-500 uppercase tracking-wider px-3">Financeiro</p>
      </div>
      <Link to="/client/invoices" onClick={onClick} className={linkClass('/client/invoices')}>
        <span>🧾</span> Faturas
      </Link>
      <Link to="/client/payments" onClick={onClick} className={linkClass('/client/payments')}>
        <span>💳</span> Pagamentos
      </Link>

      <div className="pt-3 pb-1">
        <p className="text-xs text-gray-500 uppercase tracking-wider px-3">Conta</p>
      </div>
      <Link to="/client/account" onClick={onClick} className={linkClass('/client/account')}>
        <span>👤</span> A minha conta
      </Link>
    </nav>
  );

  return (
    <>
      {/* Desktop: direct flex child, identical to original committed structure */}
      <aside className="hidden md:flex flex-col w-56 bg-gray-800 text-white p-4 shrink-0">
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Área de Família</h2>
        </div>
        {navLinks()}
      </aside>

      {/* Mobile: slide-in drawer with backdrop */}
      <div className={`fixed inset-0 z-40 md:hidden transition-opacity duration-200 ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
        <div className="absolute inset-0 bg-black/50" onClick={onClose} />
        <div className={`absolute inset-y-0 left-0 transform transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
          <aside className="w-56 bg-gray-800 text-white flex flex-col p-4 h-full">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Área de Família</h2>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-white p-1 rounded"
                aria-label="Fechar menu"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {navLinks(onClose)}
          </aside>
        </div>
      </div>
    </>
  );
}
