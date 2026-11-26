import type { ReactNode } from 'react';
import { TABS, type Tab } from './tabs';
import Clock from '../Clock';

interface Props {
  tab: Tab;
  onTab: (tab: Tab) => void;
  /** Sign-in state for the top bar's button; the phone has it under Mais. */
  account: ReactNode;
  children: ReactNode;
}

/**
 * The frame every everyday screen sits in: a top bar in a browser, a bottom
 * bar on a phone (thumbs), and the screen between them scrolling on its own.
 * Planta 2D, editing and the full-screen pages (Relatórios, Estado da ponte)
 * stay outside it, as before.
 */
export default function AppShell({ tab, onTab, account, children }: Props) {
  return (
    <div className="h-[100dvh] bg-zinc-950 text-zinc-50 flex flex-col overflow-hidden">
      <nav
        aria-label="Secções"
        className="hidden md:flex items-center gap-1 px-5 pb-2.5 border-b border-zinc-800/60 bg-zinc-950 shrink-0"
        style={{ paddingTop: 'max(0.625rem, env(safe-area-inset-top))' }}
      >
        <span className="text-base font-semibold text-zinc-100 mr-4">Casa</span>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors ${
              tab === t.id ? 'bg-amber-400 text-zinc-950 font-semibold' : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
            }`}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          <Clock />
          {account}
        </div>
      </nav>

      <main className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{children}</main>

      <nav
        aria-label="Secções"
        className="md:hidden grid grid-cols-5 border-t border-zinc-800 bg-zinc-950 shrink-0"
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        {TABS.filter(t => t.phone).map(t => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`flex flex-col items-center gap-1 pt-2 pb-1 min-h-[52px] text-[11px] ${
              tab === t.id ? 'text-amber-400' : 'text-zinc-400'
            }`}
          >
            <t.icon size={22} strokeWidth={1.8} /> {t.short ?? t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
