import { Link, Outlet, useLocation } from 'react-router-dom';
import {
  Banknote, ShieldCheck, User, Building2,
  ExternalLink, LogOut, FolderTree,
  Wrench, FileText, Calculator, TrendingUp, RefreshCw, BarChart2, Waves, Receipt,
} from 'lucide-react';
import { Role } from '@shared/models/Roles';
import { auth } from '@shared/firebase';
import { useEffect, useState } from 'react';
import { useUser } from '@shared/hooks';
import { logout } from '@shared/firebase/auth';
import { OrgSelector } from './OrgSelector';
import { useEntity } from '../../hooks/EntityContext';

type NavItem = {
  path: string;
  label: string;
  icon: JSX.Element;
  requiredRole?: Role;
  entities?: string[]; // if set, only show for these entity IDs
};

function usePersistedToggle(key: string, def = true) {
  const [open, setOpen] = useState<boolean>(() => {
    const raw = localStorage.getItem(key);
    return raw == null ? def : raw === '1';
  });
  useEffect(() => { localStorage.setItem(key, open ? '1' : '0'); }, [key, open]);
  return { open, setOpen };
}

function Section({
  title, children, storeKey, defaultOpen = true,
}: { title: string; children: React.ReactNode; storeKey: string; defaultOpen?: boolean }) {
  const { open, setOpen } = usePersistedToggle(`nav:${storeKey}`, defaultOpen);
  return (
    <div className="mb-3">
      <button
        className="w-full flex items-center justify-between px-2 py-1.5 text-sm font-semibold text-zinc-300 hover:text-white"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <span className="text-xs text-zinc-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="mt-1 space-y-1">{children}</div>}
    </div>
  );
}

function NavLink({ to, icon, label, active }: { to: string; icon: JSX.Element; label: string; active: boolean }) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-zinc-800 ${
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
  const { selectedEntity } = useEntity();
  if (!user) return null;

  const setupItems: NavItem[] = [
    { path: '/setup/people',       label: 'People',               icon: <User size={18} />,       requiredRole: Role.FinhubAdmin },
    { path: '/setup/companies',    label: 'Companies',            icon: <Building2 size={18} />,  requiredRole: Role.FinhubAdmin },
    { path: '/setup/accounts',     label: 'Accounts',             icon: <Banknote size={18} />,   requiredRole: Role.FinhubAdmin },
    { path: '/setup/contracts',    label: 'Employment Contracts', icon: <FileText size={18} />,   requiredRole: Role.FinhubAdmin, entities: ['noisysource'] },
    { path: '/setup/ec-contracts', label: 'EC Contracts',         icon: <TrendingUp size={18} />, requiredRole: Role.FinhubAdmin, entities: ['noisysource'] },
  ];

  const financeItems: NavItem[] = [
    { path: '/recurring',  label: 'Recurring',     icon: <RefreshCw size={18} />,  requiredRole: Role.FinhubAdmin },
    { path: '/forecast',   label: 'Forecast',      icon: <BarChart2 size={18} />,  requiredRole: Role.FinhubAdmin },
    { path: '/cashflow',   label: 'Cash Flow',     icon: <Waves size={18} />,      requiredRole: Role.FinhubAdmin },
    { path: '/payroll',    label: 'Payroll',       icon: <Calculator size={18} />, requiredRole: Role.FinhubAdmin, entities: ['noisysource', 'noisyphocus'] },
    { path: '/irs',        label: 'IRS Simulator', icon: <Receipt size={18} />,    requiredRole: Role.FinhubAdmin, entities: ['private'] },
    { path: '/categories', label: 'Categories',    icon: <FolderTree size={18} />, requiredRole: Role.FinhubAdmin },
  ];

  const adminItems: NavItem[] = [
    { path: '/admin/access', label: 'Manage Access', icon: <ShieldCheck size={18} />, requiredRole: Role.Owner },
    { path: '/admin/dev',    label: 'Dev Tools',     icon: <Wrench size={18} />,      requiredRole: Role.Owner },
  ];

  const canSee = (item: NavItem) => {
    if (item.requiredRole && !user.roles?.[item.requiredRole]) return false;
    if (item.entities && !item.entities.includes(selectedEntity.id)) return false;
    return true;
  };

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  const handleLogout = async () => {
    await logout(auth);
    const isLocalhost = window.location.hostname === 'localhost';
    window.location.href = isLocalhost ? 'http://localhost:5173' : 'https://kidclub.pt';
  };

  return (
    <div className="h-screen flex text-white">
      <aside className="w-64 bg-zinc-900 p-4 flex flex-col justify-between overflow-y-auto">
        <div>
          <div className="mb-4">
            <h1 className="text-xl font-bold flex items-center gap-2">
              <span>💰</span> FinHub
            </h1>
            <div className="mt-2">
              <OrgSelector />
            </div>
          </div>

          <nav>
            <Section title="Setup" storeKey="setup" defaultOpen={false}>
              {setupItems.filter(canSee).map(i => (
                <NavLink key={i.path} to={i.path} label={i.label} icon={i.icon} active={isActive(i.path)} />
              ))}
            </Section>

            <Section title="Finance" storeKey="finance" defaultOpen>
              {financeItems.filter(canSee).map(i => (
                <NavLink key={i.path} to={i.path} label={i.label} icon={i.icon} active={isActive(i.path)} />
              ))}
            </Section>

            <Section title="Admin" storeKey="admin" defaultOpen={false}>
              {adminItems.filter(canSee).map(i => (
                <NavLink key={i.path} to={i.path} label={i.label} icon={i.icon} active={isActive(i.path)} />
              ))}
            </Section>
          </nav>
        </div>

        <div className="space-y-2 border-t border-zinc-800 pt-4 text-sm">
          <a
            href="https://kidclub.pt"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 rounded-md text-zinc-400 hover:bg-zinc-800"
          >
            <ExternalLink size={16} /> KidClub
          </a>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-red-400 hover:bg-zinc-800"
          >
            <LogOut size={16} /> Logout
          </button>
        </div>
      </aside>

      <main className="flex-1 bg-zinc-950 p-6 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
