import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  ShieldCheck, User, Building2,
  ExternalLink, LogOut, FolderTree,
  Wrench, LayoutDashboard, KeyRound, Sparkles,
} from 'lucide-react';
import { auth } from '@shared/firebase';
import { useEffect, useState } from 'react';
import { useUser } from '@shared/hooks';
import { logout } from '@shared/firebase/auth';
import { GcpCostCard } from '../GcpCostCard';
import { NotificationBell } from '../NotificationBell';
import { runInsuranceRenewalNotifications } from '../../lib/notificationGenerators';
import {
  ENTITY_NAV, ENTITY_OPTIONS, GLOBAL_NAV, featureAvailable, isEntityId,
  readStoredEntity, writeStoredEntity, type EntityId,
} from './nav';

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
  const navigate = useNavigate();
  const user = useUser();

  // The picked entity: the URL's when on an entity page, otherwise the last
  // one picked. Every entity link in the menu uses it — nothing is inferred
  // from "the page you were on before".
  const [segEntity, segFeature] = location.pathname.split('/').filter(Boolean);
  const urlEntity = isEntityId(segEntity) ? segEntity : null;
  const urlFeature = urlEntity ? segFeature : undefined;
  const [storedEntity, setStoredEntity] = useState<EntityId>(() => readStoredEntity() ?? 'private');
  const entity = urlEntity ?? storedEntity;

  useEffect(() => {
    if (urlEntity && urlEntity !== storedEntity) {
      setStoredEntity(urlEntity);
      writeStoredEntity(urlEntity);
    }
  }, [urlEntity, storedEntity]);

  useEffect(() => {
    runInsuranceRenewalNotifications().catch(console.error);
  }, []);

  if (!user) return null;

  function pickEntity(next: EntityId) {
    setStoredEntity(next);
    writeStoredEntity(next);
    // On an entity page, stay on the same feature if the new entity has it.
    if (urlEntity) {
      const feature = urlFeature && featureAvailable(urlFeature, next) ? urlFeature : 'accounts';
      navigate(`/${next}/${feature}`);
    }
  }

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  const isOwner = user.roles?.owner;

  const handleLogout = async () => {
    await logout(auth);
    const isLocalhost = window.location.hostname === 'localhost';
    window.location.href = isLocalhost ? 'http://localhost:5173' : 'https://kidclub.pt';
  };

  const groups = ENTITY_NAV
    .map(g => ({ ...g, items: g.items.filter(i => i.entities.includes(entity)) }))
    .filter(g => g.items.length > 0);

  return (
    <div className="h-screen flex text-white">
      <aside className="w-60 bg-zinc-900 p-3 flex flex-col justify-between overflow-y-auto shrink-0">
        <div>
          <div className="mb-4 px-2 flex items-center justify-between">
            <h1 className="text-lg font-bold flex items-center gap-2">
              <span>💰</span> FinHub
            </h1>
            <NotificationBell />
          </div>

          <nav className="space-y-1">
            {/* Pages that show every entity together */}
            <div className="mb-3 space-y-0.5">
              {/* FinHub v2 (HANDOFF-finhub-v2.md), being built next to this app */}
              <NavLink to="/v2/noisysource" icon={<Sparkles size={16} />} label="FinHub v2 · NoisySource" active={false} />
              <NavLink to="/" icon={<LayoutDashboard size={16} />} label="Visão geral" active={location.pathname === '/'} />
              {GLOBAL_NAV.map(({ feature, label, icon: Icon }) => (
                <NavLink key={feature} to={`/${entity}/${feature}`} icon={<Icon size={16} />} label={label}
                  active={urlFeature === feature} />
              ))}
            </div>

            {/* Entity picker — everything below it belongs to this entity */}
            <div className="border-t border-zinc-800 pt-3 px-2">
              <label htmlFor="entity-picker" className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-1">
                A ver
              </label>
              <select
                id="entity-picker"
                value={entity}
                onChange={e => pickEntity(e.target.value as EntityId)}
                className="w-full bg-zinc-800 border border-zinc-700 text-white rounded-md px-2 py-1.5 text-sm"
              >
                {ENTITY_OPTIONS.map(o => (
                  <option key={o.id} value={o.id}>{o.emoji} {o.label}</option>
                ))}
              </select>
            </div>

            {groups.map(g => (
              <div key={g.title} className="pt-2">
                <div className="px-2 py-1 text-xs font-bold text-zinc-500 uppercase tracking-wider">{g.title}</div>
                <div className="space-y-0.5">
                  {g.items.map(({ feature, label, icon: Icon }) => (
                    <NavLink key={feature} to={`/${entity}/${feature}`} icon={<Icon size={16} />} label={label}
                      active={urlEntity === entity && urlFeature === feature} />
                  ))}
                </div>
              </div>
            ))}

            <div className="border-t border-zinc-800 mt-3 pt-3">
              <NavLink to="/vault" icon={<KeyRound size={16} />} label="Vault" active={isActive('/vault')} />
            </div>

            {isOwner && (
              <Section title="Admin" emoji="⚙️" storeKey="admin">
                <NavLink to="/setup/people"    icon={<User size={16} />}        label="Pessoas"    active={isActive('/setup/people')} />
                <NavLink to="/setup/companies" icon={<Building2 size={16} />}   label="Empresas"   active={isActive('/setup/companies')} />
                <NavLink to="/admin/access"    icon={<ShieldCheck size={16} />} label="Acessos"    active={isActive('/admin/access')} />
                <NavLink to="/admin/dev"       icon={<Wrench size={16} />}      label="Dev Tools"  active={isActive('/admin/dev')} />
                <NavLink to="/noisysource/categories" icon={<FolderTree size={16} />} label="Categorias" active={isActive('/noisysource/categories')} />
              </Section>
            )}
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
