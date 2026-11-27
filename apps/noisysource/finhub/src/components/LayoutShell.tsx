import React, { useState } from 'react';
import {
  BookOpen,
  Briefcase,
  Calculator,
  CalendarDays,
  CheckSquare,
  FolderSync,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Repeat,
  TrendingUp,
  Wallet,
  X,
  Handshake,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTreasury } from '../contexts/TreasuryContext';
import { CURRENCY_OPTIONS, type CurrencyCode, type NavSection } from '../types/finance';

interface LayoutShellProps {
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  onPrimaryAction: () => void;
  primaryActionLabel: string;
  children: React.ReactNode;
}

const NAV_ITEMS: Array<{ id: NavSection; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'accounts', label: 'Accounts', icon: Wallet },
  { id: 'expenses', label: 'Expenses & Subs', icon: Repeat },
  { id: 'personal_income', label: 'Personal Income', icon: Briefcase },
  { id: 'client_contracts', label: 'Client Contracts', icon: Handshake },
  { id: 'taxes', label: 'Taxes (IVA · IRS · IRC)', icon: Calculator },
  { id: 'credits', label: 'Credits & Loans', icon: Landmark },
  { id: 'forecast', label: '12-Month Forecast', icon: TrendingUp },
  { id: 'calendar', label: 'Payslip Calendar', icon: CalendarDays },
  { id: 'reconciliation', label: 'Reconciliation', icon: CheckSquare },
  { id: 'documents', label: 'Gmail & Drive', icon: FolderSync },
  { id: 'ledger', label: 'Ledger', icon: BookOpen },
];

export function LayoutShell({
  activeSection,
  onSelectSection,
  onPrimaryAction,
  primaryActionLabel,
  children,
}: LayoutShellProps) {
  const { user, signOut } = useAuth();
  const {
    entities,
    entityFilter,
    setEntityFilter,
    currencyCode,
    updateCurrencyPreference,
    statementLines,
    reimbursements,
    invoiceDocuments,
  } = useTreasury();
  const [mobileOpen, setMobileOpen] = useState(false);

  const activeNav = NAV_ITEMS.find((n) => n.id === activeSection) ?? NAV_ITEMS[0];
  const pendingReconCount = statementLines.filter(
    (l) => l.reconciliationStatus === 'unmatched' || l.reconciliationStatus === 'suggested'
  ).length;
  const openReimbCount = reimbursements.filter((r) => r.status === 'open').length;
  const unlinkedDocCount = invoiceDocuments.filter((d) => d.status === 'inbox').length;

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#0F172A] border-r border-slate-800">
      <div className="h-14 px-5 flex items-center justify-between border-b border-slate-800 shrink-0">
        <span className="text-base font-semibold tracking-tight text-slate-100 whitespace-nowrap">
          Strata Treasury
        </span>
        <button
          onClick={() => setMobileOpen(false)}
          className="lg:hidden text-slate-400 hover:text-slate-200 p-1"
          aria-label="Close navigation"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeSection === item.id;
          return (
            <button
              key={item.id}
              onClick={() => {
                onSelectSection(item.id);
                setMobileOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isActive
                  ? 'bg-blue-600/15 text-blue-400'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/60'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </span>
              {item.id === 'expenses' && openReimbCount > 0 && (
                <span className="font-mono tabular-nums text-xs text-amber-400">
                  {openReimbCount}
                </span>
              )}
              {item.id === 'reconciliation' && pendingReconCount > 0 && (
                <span className="font-mono tabular-nums text-xs text-amber-400">
                  {pendingReconCount}
                </span>
              )}
              {item.id === 'documents' && unlinkedDocCount > 0 && (
                <span className="font-mono tabular-nums text-xs text-amber-400">
                  {unlinkedDocCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-slate-800 space-y-3 shrink-0">
        <div>
          <label htmlFor="sidebar-currency" className="block text-xs text-slate-400 mb-1">
            Reporting Currency
          </label>
          <select
            id="sidebar-currency"
            value={currencyCode}
            onChange={(e) => void updateCurrencyPreference(e.target.value as CurrencyCode)}
            className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
          >
            {CURRENCY_OPTIONS.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} ({c.symbol})
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-200 truncate">
              {user?.displayName || 'Account'}
            </p>
            <p className="text-xs text-slate-500 truncate">{user?.email}</p>
          </div>
          <button
            onClick={() => void signOut()}
            title="Sign out"
            aria-label="Sign out"
            className="p-2 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors shrink-0 cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen">
        {sidebarContent}
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative w-64 max-w-[80vw] h-full z-10">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 bg-[#0F172A]/95 backdrop-blur border-b border-slate-800 px-4 lg:px-6 flex items-center justify-between gap-6 sticky top-0 z-30">
          {/* Zone 1: Breadcrumb + Mobile Toggle */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-1.5 text-slate-400 hover:text-slate-100 rounded-lg"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline whitespace-nowrap">Cockpit</span>
              <span className="text-slate-600 hidden sm:inline" aria-hidden="true">/</span>
              <span className="font-semibold text-slate-100 truncate">{activeNav.label}</span>
            </div>
          </div>

          {/* Zone 2: Global Entity Filter */}
          <div className="flex items-center gap-2 min-w-0">
            <label htmlFor="entity-switcher" className="sr-only">
              Entity Scope
            </label>
            <select
              id="entity-switcher"
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              className="bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-100 focus:outline-none focus:border-blue-500 max-w-[220px] truncate"
            >
              <option value="all">All Entities ({entities.length})</option>
              {entities.map((ent) => (
                <option key={ent.id} value={ent.id}>
                  {ent.name} · {ent.entityType === 'personal' ? 'Personal' : 'Company'}
                </option>
              ))}
            </select>
          </div>

          {/* Zone 3: Single Contextual Action */}
          <div className="shrink-0">
            <button
              onClick={onPrimaryAction}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{primaryActionLabel}</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-6 max-w-[1440px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
