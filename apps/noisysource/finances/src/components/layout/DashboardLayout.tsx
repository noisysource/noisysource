import { Link, Outlet, useLocation } from 'react-router-dom';
import {
  Banknote, ShieldCheck, User, Building2,
  ExternalLink, LogOut, FolderTree,
  Wrench, FileText, Calculator, TrendingUp, RefreshCw, BarChart2, Waves, Receipt, LayoutDashboard, Briefcase, CreditCard, KeyRound, Store,
} from 'lucide-react';
import { auth } from '@shared/firebase';
import { useEffect, useState } from 'react';
import { useUser } from '@shared/hooks';
import { logout } from '@shared/firebase/auth';
import { GcpCostCard } from '../GcpCostCard';

function usePersistedToggle(key: string, def = true) {
  const [open, setOpen] = useState<boolean>(() => {
    const raw = localStorage.getItem(key);
    return raw == null ? def : raw === '1';
  });
  useEffect(() => { localStorage.setItem(key, open ? '1' : '0'); }, [key, open]);
  return { open, setOpen };
}

function Section({
  title, emoji, children, storeKey, defaultOpen = false,
}: { title: string; emoji?: string; children: React.ReactNode; storeKey: string; defaultOpen?: boolean }) {
  const { open, setOpen } = usePersistedToggle(`nav:${storeKey}`, defaultOpen);
  return (
    <div className="mb-2">
      <button
        className="w-full flex items-center justify-between px-2 py-1.5 text-xs font-bold text-zinc-400 uppercase tracking-wider hover:text-white"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>{emoji && <span className="mr-1.5">{emoji}</span>}{title}</span>
        <span className="text-zinc-600">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="mt-0.5 space-y-0.5">{children}</div>}
    </div>
  );
}

function NavLink({ to, icon, label, active }: { to: string; icon: JSX.Element; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors hover:bg-zinc-800 ${
        active ? 'bg-zinc-800 text-white' : 'text-zinc-400'
      }`}
    >
      {icon} {label}
    </Link>
  );
}

export default function DashboardLayout() {
  const location = useLocation();
  const user = useUser();
  if (!user) return null;

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  // Matches any entity's version of a feature (e.g. "recurring" hits /private/recurring AND /noisysource/recurring)
  const isFeature = (feature: string) =>
    location.pathname.split('/').at(-1) === feature;

  // Derive current entity from URL so Gestão links keep entity context
  const VALID_ENTITIES = ['private', 'noisysource', 'noisyphocus'];
  const pathEntity = location.pathname.split('/').filter(Boolean)[0] ?? '';
  const currentEntity = VALID_ENTITIES.includes(pathEntity) ? pathEntity : 'noisysource';

  const isOwner = user.roles?.owner;

  const handleLogout = async () => {
    await logout(auth);
    const isLocalhost = window.location.hostname === 'localhost';
    window.location.href = isLocalhost ? 'http://localhost:5173' : 'https://kidclub.pt';
  };

  return (
    <div className="h-screen flex text-white">
      <aside className="w-60 bg-zinc-900 p-3 flex flex-col justify-between overflow-y-auto shrink-0">
        <div>
          <div className="mb-4 px-2">
            <h1 className="text-lg font-bold flex items-center gap-2">
              <span>💰</span> FinHub
            </h1>
          </div>

          <nav className="space-y-1">
            {/* Dashboard — global */}
            <div className="mb-3">
              <NavLink to="/" icon={<LayoutDashboard size={16} />} label="Dashboard" active={location.pathname === '/'} />
            </div>

            {/* Private */}
            <Section title="Private" emoji="🏠" storeKey="entity:private" defaultOpen>
              <NavLink to="/private/accounts" icon={<Banknote size={16} />}   label="Contas"            active={isActive('/private/accounts')} />
              <NavLink to="/private/income"   icon={<Briefcase size={16} />}  label="Rendimento"        active={isActive('/private/income')} />
              <NavLink to="/private/irs"      icon={<Receipt size={16} />}    label="IRS"               active={isActive('/private/irs')} />
            </Section>

            {/* NoisySource */}
            <Section title="NoisySource" emoji="🏢" storeKey="entity:noisysource" defaultOpen>
              <NavLink to="/noisysource/accounts"     icon={<Banknote size={16} />}   label="Contas"       active={isActive('/noisysource/accounts')} />
              <NavLink to="/noisysource/ec-contracts" icon={<TrendingUp size={16} />} label="EC Contracts" active={isActive('/noisysource/ec-contracts')} />
              <NavLink to="/noisysource/contracts"    icon={<FileText size={16} />}   label="Contratos"    active={isActive('/noisysource/contracts')} />
              <NavLink to="/noisysource/payroll"      icon={<Calculator size={16} />} label="Payroll"      active={isActive('/noisysource/payroll')} />
            </Section>

            {/* NoisyPhocus */}
            <Section title="NoisyPhocus" emoji="📸" storeKey="entity:noisyphocus">
              <NavLink to="/noisyphocus/accounts" icon={<Banknote size={16} />}   label="Contas"   active={isActive('/noisyphocus/accounts')} />
              <NavLink to="/noisyphocus/revenue"  icon={<Store size={16} />}      label="KidClub"  active={isActive('/noisyphocus/revenue')} />
              <NavLink to="/noisyphocus/payroll"  icon={<Calculator size={16} />} label="Payroll"  active={isActive('/noisyphocus/payroll')} />
            </Section>

            {/* Gestão — cross-entity features, entity context preserved from URL */}
            <Section title="Gestão" emoji="📊" storeKey="gestao" defaultOpen>
              <NavLink to={`/${currentEntity}/recurring`} icon={<RefreshCw size={16} />}  label="Recorrentes" active={isFeature('recurring')} />
              <NavLink to={`/${currentEntity}/credits`}   icon={<CreditCard size={16} />} label="Créditos"    active={isFeature('credits')} />
              <NavLink to={`/${currentEntity}/forecast`}  icon={<BarChart2 size={16} />}  label="Forecast"    active={isFeature('forecast')} />
              <NavLink to="/vault"                        icon={<KeyRound size={16} />}   label="Vault"       active={isActive('/vault')} />
            </Section>

            {/* Admin */}
            {isOwner && (
              <Section title="Admin" emoji="⚙️" storeKey="admin">
                <NavLink to="/setup/people"    icon={<User size={16} />}       label="People"        active={isActive('/setup/people')} />
                <NavLink to="/setup/companies" icon={<Building2 size={16} />}  label="Companies"     active={isActive('/setup/companies')} />
                <NavLink to="/admin/access"    icon={<ShieldCheck size={16} />} label="Access"       active={isActive('/admin/access')} />
                <NavLink to="/admin/dev"       icon={<Wrench size={16} />}     label="Dev Tools"     active={isActive('/admin/dev')} />
                <NavLink to="/noisysource/categories" icon={<FolderTree size={16} />} label="Categories" active={isActive('/noisysource/categories')} />
              </Section>
            )}

            {/* Cashflow — entity-agnostic shortcut, goes to noisysource by default */}
            <div className="mt-2 pt-2 border-t border-zinc-800">
              <NavLink to="/noisysource/cashflow" icon={<Waves size={16} />} label="Cash Flow" active={isActive('/noisysource/cashflow') || isActive('/private/cashflow')} />
            </div>
          </nav>
        </div>

        <div>
          <div className="mb-3 border-t border-zinc-800 pt-3">
            <GcpCostCard />
          </div>
          <div className="space-y-1 text-sm">
            <a
              href="https://kidclub.pt"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-zinc-400 hover:bg-zinc-800"
            >
              <ExternalLink size={14} /> KidClub
            </a>
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-red-400 hover:bg-zinc-800"
            >
              <LogOut size={14} /> Logout
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 bg-zinc-950 p-6 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
