// apps/finhub/src/components/layout/DashboardLayout.tsx
import { Link, Outlet, useLocation } from 'react-router-dom';
import {
  Banknote, ShieldCheck, User, Building2, UserCog,
  CalendarCheck, ListChecks, ListTree, ExternalLink, LogOut, FolderTree,
  Wrench, FileText, Calculator
} from 'lucide-react';
import { Role } from '@shared/models/Roles';
import { auth } from '@shared/firebase';
import { useEffect, useState } from 'react';
import { useUser } from '@shared/hooks';
import { logout } from '@shared/firebase/auth';
import { OrgSelector } from './OrgSelector';

type NavItem = { path: string; label: string; icon: JSX.Element; requiredRole?: Role };

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
      className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-zinc-800 ${active ? 'bg-zinc-800 text-white' : 'text-zinc-400'
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

  // Finance (core)
  const financeItems: NavItem[] = [
    { path: '/accounts', label: 'Accounts', icon: <Banknote size={18} />, requiredRole: Role.FinhubAdmin },
    { path: '/categories', label: 'Categories', icon: <FolderTree size={18} />, requiredRole: Role.FinhubAdmin },
    { path: '/templates', label: 'Template Manager', icon: <ListChecks size={18} />, requiredRole: Role.FinhubAdmin },
    { path: '/planned', label: 'Planned Instances', icon: <CalendarCheck size={18} />, requiredRole: Role.FinhubAdmin },
    { path: '/ledger', label: 'Transactions', icon: <ListTree size={18} />, requiredRole: Role.FinhubAdmin },
    { path: '/balances', label: 'Balances', icon: <Banknote size={18} />, requiredRole: Role.FinhubAdmin },
  ];

  // Employment (own collapsible)
  const employmentItems: NavItem[] = [
    { path: '/employment/contracts', label: 'Contracts', icon: <FileText size={18} />, requiredRole: Role.FinhubAdmin },
    { path: '/employment/payroll', label: 'Payroll', icon: <Calculator size={18} />, requiredRole: Role.FinhubAdmin },
  ];

  // Admin
  const adminItems: NavItem[] = [
    { path: '/admin/people', label: 'People', icon: <User size={18} />, requiredRole: Role.Owner },
    { path: '/admin/companies', label: 'Companies', icon: <Building2 size={18} />, requiredRole: Role.Owner },
    { path: '/admin/access', label: 'Manage Access', icon: <ShieldCheck size={18} />, requiredRole: Role.Owner },
    { path: '/admin/dev', label: 'Dev Tools', icon: <Wrench size={18} />, requiredRole: Role.Owner },
  ];

  const canSee = (item: NavItem) => !item.requiredRole || user.roles?.[item.requiredRole];
  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  const handleLogout = async () => {
    await logout(auth);
    const isLocalhost = window.location.hostname === 'localhost';
    window.location.href = isLocalhost ? 'http://localhost:5173' : 'https://kidclub.pt';
  };

  return (
    <div className="h-screen flex text-white">
      <aside className="w-64 bg-zinc-900 p-4 flex flex-col justify-between">
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
            <Section title="Finance" storeKey="finance" defaultOpen>
              {financeItems.filter(canSee).map(i => (
                <NavLink key={i.path} to={i.path} label={i.label} icon={i.icon} active={isActive(i.path)} />
              ))}
            </Section>

            <Section title="Employment" storeKey="employment" defaultOpen={false}>
              {employmentItems.filter(canSee).map(i => (
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
            <ExternalLink size={16} /> ArcoÍris Landing
          </a>
          <a
            href="https://kidclub.pt/admin"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 rounded-md text-zinc-400 hover:bg-zinc-800"
          >
            <ExternalLink size={16} /> ArcoÍris Backoffice
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