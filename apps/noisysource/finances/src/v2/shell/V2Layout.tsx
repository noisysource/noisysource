import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ArrowLeft, FileSignature, Wallet } from 'lucide-react';

const COMPANIES = [
  { id: 'noisysource', label: 'NoisySource', ready: true },
  { id: 'noisyphocus', label: 'NoisyPhocus', ready: false },
  { id: 'casa', label: 'Casa', ready: false },
] as const;

const NS_NAV = [
  { to: '/v2/noisysource', label: 'Tesouraria', icon: Wallet, end: true },
  { to: '/v2/noisysource/contratos', label: 'Contratos EC', icon: FileSignature, end: false },
];

/** FinHub v2 shell: one module per company (HANDOFF-finhub-v2.md). Only NoisySource exists yet. */
export default function V2Layout() {
  const { pathname } = useLocation();
  const company = pathname.split('/')[2] ?? 'noisysource';

  return (
    <div className="h-screen flex text-white">
      <aside className="w-56 bg-zinc-900 p-3 flex flex-col justify-between shrink-0">
        <div>
          <div className="mb-4 px-2">
            <h1 className="text-lg font-bold">FinHub <span className="text-xs font-semibold text-emerald-400 align-top">v2</span></h1>
            <p className="text-xs text-zinc-500">Eventos como registo</p>
          </div>

          <label className="block px-2 text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1" htmlFor="v2-company">Empresa</label>
          <select
            id="v2-company"
            value={company}
            disabled
            className="mx-2 mb-3 w-[calc(100%-1rem)] bg-zinc-800 border border-zinc-700 text-white rounded-md px-2 py-1.5 text-sm"
            title="NoisyPhocus e Casa vêm depois da NoisySource"
          >
            {COMPANIES.map(c => <option key={c.id} value={c.id}>{c.label}{c.ready ? '' : ' (em breve)'}</option>)}
          </select>

          <nav className="space-y-0.5">
            {NS_NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium hover:bg-zinc-800 ${isActive ? 'bg-zinc-800 text-white' : 'text-zinc-400'}`}
              >
                <Icon size={16} /> {label}
              </NavLink>
            ))}
          </nav>
        </div>

        <Link to="/" className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-zinc-400 hover:bg-zinc-800">
          <ArrowLeft size={14} /> FinHub (versão atual)
        </Link>
      </aside>

      <main className="flex-1 bg-zinc-950 p-6 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
