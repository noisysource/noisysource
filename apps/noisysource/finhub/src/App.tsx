/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { TreasuryProvider, useTreasury } from './contexts/TreasuryContext';
import { AccountsView } from './components/AccountsView';
import { AuthScreen } from './components/AuthScreen';
import { CreditsLoansView } from './components/CreditsLoansView';
import { DocumentsHubView } from './components/DocumentsHubView';
import { EntitiesLedgerView } from './components/EntitiesLedgerView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ExpensesSubscriptionsView } from './components/ExpensesSubscriptionsView';
import { ForecastView } from './components/ForecastView';
import { LayoutShell } from './components/LayoutShell';
import { OnboardingModal } from './components/OnboardingModal';
import { OverviewView } from './components/OverviewView';
import { PayslipCalendarView } from './components/PayslipCalendarView';
import { PersonalIncomeView } from './components/PersonalIncomeView';
import { ReconciliationView } from './components/ReconciliationView';
import { TaxesView } from './components/TaxesView';
import { ToastContainer } from './components/ToastContainer';
import type { NavSection } from './types/finance';

function CockpitRouter() {
  const { user, authReady } = useAuth();
  const { loading, profile } = useTreasury();

  const [activeSection, setActiveSection] = useState<NavSection>('overview');
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [expenseSubModalOpen, setExpenseSubModalOpen] = useState(false);
  const [personalIncomeModalOpen, setPersonalIncomeModalOpen] = useState(false);
  const [taxSettingsModalOpen, setTaxSettingsModalOpen] = useState(false);
  const [creditModalOpen, setCreditModalOpen] = useState(false);
  const [forecastModalOpen, setForecastModalOpen] = useState(false);
  const [payslipModalOpen, setPayslipModalOpen] = useState(false);
  const [calendarTab, setCalendarTab] = useState<'calendar' | 'annual' | 'contracts'>('calendar');
  const [txModalOpen, setTxModalOpen] = useState(false);
  const [statementUploadNonce, setStatementUploadNonce] = useState(0);
  const [documentsBatchNonce, setDocumentsBatchNonce] = useState(0);

  const navigateTo = (
    section: NavSection,
    requestedCalendarTab?: 'calendar' | 'annual' | 'contracts'
  ) => {
    if (section === 'calendar' && requestedCalendarTab) {
      setCalendarTab(requestedCalendarTab);
    }
    setActiveSection(section);
  };

  if (!authReady || (user && loading)) {
    return (
      <div className="min-h-screen bg-[#0B1120] text-slate-300 flex items-center justify-center">
        <div className="space-y-3 text-center">
          <div className="w-8 h-8 border-2 border-slate-700 border-t-blue-500 rounded-full animate-spin mx-auto" />
          <p className="text-xs text-slate-400">Loading Strata Treasury...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  if (!profile || !profile.onboardingComplete) {
    return <OnboardingModal />;
  }

  const primaryActionLabel =
    activeSection === 'accounts'
      ? 'Add Account'
      : activeSection === 'expenses'
      ? 'Add Subscription'
      : activeSection === 'personal_income'
      ? 'Add Job / Income'
      : activeSection === 'taxes'
      ? 'Tax Parameters'
      : activeSection === 'credits'
      ? 'Add Credit / Loan'
      : activeSection === 'forecast'
      ? 'Add Forecast Driver'
      : activeSection === 'calendar'
      ? 'Add Payslip'
      : activeSection === 'reconciliation'
      ? 'Upload Statement'
      : activeSection === 'documents'
      ? '2025 Batch Import'
      : 'Add Ledger Entry';

  const handlePrimaryAction = () => {
    if (activeSection === 'accounts') {
      setAccountModalOpen(true);
    } else if (activeSection === 'expenses') {
      setExpenseSubModalOpen(true);
    } else if (activeSection === 'personal_income') {
      setPersonalIncomeModalOpen(true);
    } else if (activeSection === 'taxes') {
      setTaxSettingsModalOpen(true);
    } else if (activeSection === 'credits') {
      setCreditModalOpen(true);
    } else if (activeSection === 'forecast') {
      setForecastModalOpen(true);
    } else if (activeSection === 'calendar') {
      setPayslipModalOpen(true);
    } else if (activeSection === 'reconciliation') {
      setStatementUploadNonce((n) => n + 1);
    } else if (activeSection === 'documents') {
      setDocumentsBatchNonce((n) => n + 1);
    } else if (activeSection === 'ledger') {
      setTxModalOpen(true);
    } else {
      setActiveSection('ledger');
      setTxModalOpen(true);
    }
  };

  return (
    <LayoutShell
      activeSection={activeSection}
      onSelectSection={setActiveSection}
      onPrimaryAction={handlePrimaryAction}
      primaryActionLabel={primaryActionLabel}
    >
      {activeSection === 'overview' && <OverviewView onNavigate={setActiveSection} />}
      {activeSection === 'accounts' && (
        <AccountsView
          createAccountModalOpen={accountModalOpen}
          onOpenCreateAccountModal={() => setAccountModalOpen(true)}
          onCloseCreateAccountModal={() => setAccountModalOpen(false)}
        />
      )}
      {activeSection === 'expenses' && (
        <ExpensesSubscriptionsView
          createSubModalOpen={expenseSubModalOpen}
          onOpenCreateSubModal={() => setExpenseSubModalOpen(true)}
          onCloseCreateSubModal={() => setExpenseSubModalOpen(false)}
          onNavigate={setActiveSection}
        />
      )}
      {activeSection === 'personal_income' && (
        <PersonalIncomeView
          createModalOpen={personalIncomeModalOpen}
          onOpenCreateModal={() => setPersonalIncomeModalOpen(true)}
          onCloseCreateModal={() => setPersonalIncomeModalOpen(false)}
          onNavigate={navigateTo}
        />
      )}
      {activeSection === 'taxes' && (
        <TaxesView
          settingsModalOpen={taxSettingsModalOpen}
          onOpenSettingsModal={() => setTaxSettingsModalOpen(true)}
          onCloseSettingsModal={() => setTaxSettingsModalOpen(false)}
          onNavigate={setActiveSection}
        />
      )}
      {activeSection === 'credits' && (
        <CreditsLoansView
          createModalOpen={creditModalOpen}
          onCloseCreateModal={() => setCreditModalOpen(false)}
          onOpenCreateModal={() => setCreditModalOpen(true)}
        />
      )}
      {activeSection === 'forecast' && (
        <ForecastView
          createModalOpen={forecastModalOpen}
          onCloseCreateModal={() => setForecastModalOpen(false)}
          onOpenCreateModal={() => setForecastModalOpen(true)}
        />
      )}
      {activeSection === 'calendar' && (
        <PayslipCalendarView
          createModalOpen={payslipModalOpen}
          onCloseCreateModal={() => setPayslipModalOpen(false)}
          onOpenCreateModal={() => setPayslipModalOpen(true)}
          initialTab={calendarTab}
        />
      )}
      {activeSection === 'reconciliation' && (
        <ReconciliationView uploadTriggerNonce={statementUploadNonce} />
      )}
      {activeSection === 'documents' && (
        <DocumentsHubView initialTabNonce={documentsBatchNonce} />
      )}
      {activeSection === 'ledger' && (
        <EntitiesLedgerView
          createTxModalOpen={txModalOpen}
          onCloseCreateTxModal={() => setTxModalOpen(false)}
          onOpenCreateTxModal={() => setTxModalOpen(true)}
          onNavigate={setActiveSection}
        />
      )}
    </LayoutShell>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <TreasuryProvider>
          <CockpitRouter />
          <ToastContainer />
        </TreasuryProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
