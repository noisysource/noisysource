import { Link, useLocation } from 'react-router-dom';

export default function ClientSidebar() {
  const location = useLocation();
  
  const isActive = (path: string) => {
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  const linkClass = (path: string) => {
    const baseClass = "block py-2 px-4 rounded-lg transition-colors";
    return isActive(path)
      ? `${baseClass} bg-blue-600 text-white`
      : `${baseClass} hover:bg-gray-700 text-gray-300`;
  };

  return (
    <aside className="w-64 bg-gray-800 text-white p-4">
      <h2 className="text-xl font-bold mb-6">Client Area</h2>
      <nav>
        <ul className="space-y-1">
          <li>
            <Link to="/client" className={linkClass('/client')}>
              Family Dashboard
            </Link>
          </li>
          <li>
            <Link to="/client/family/schedule" className={linkClass('/client/family/schedule')}>
              Family Schedule
            </Link>
          </li>
          <li>
            <Link to="/client/children" className={linkClass('/client/children')}>
              Manage Children
            </Link>
          </li>
          <li className="pt-4 mt-4 border-t border-gray-700">
            <div className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Billing
            </div>
          </li>
          <li>
            <Link to="/client/family/invoices" className={linkClass('/client/family/invoices')}>
              Family Invoices
            </Link>
          </li>
          <li>
            <Link to="/client/family/payments" className={linkClass('/client/family/payments')}>
              Payment History
            </Link>
          </li>
        </ul>
      </nav>
    </aside>
  );
}
