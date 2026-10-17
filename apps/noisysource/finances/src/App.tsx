import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { UserProvider } from '@shared/hooks';
import { auth, db } from './lib/firebase';

import DashboardLayout from './components/layout/DashboardLayout';
import { ProtectRoute } from '@shared/ProtectedRoute';
import { Role } from '@shared/models/Roles';
import LoginPage from '@shared/Login';

// Dashboard
import DashboardPage from './pages/DashboardPage';

// Setup
import PeoplePage from './pages/admin/PeoplePage';
import CompaniesPage from './pages/admin/CompaniesPage';
import AccountsPage from './pages/AccountsPage';
import TeamPage from './pages/TeamPage';
import EcContractsPage from './pages/EcContractsPage';
import IncomeSourcesPage from './pages/IncomeSourcesPage';

// Finance
import RecurringPage from './pages/RecurringPage';
import CreditsPage from './pages/CreditsPage';
import ForecastPage from './pages/ForecastPage';
import IRSPage from './pages/IRSPage';
import CategoriesPage from './pages/CategoriesPage';
import NoisyPhocusRevenuePage from './pages/NoisyPhocusRevenuePage';
import LoansPage from './pages/LoansPage';
import VatPage from './pages/VatPage';
import InsurancesPage from './pages/InsurancesPage';
import MonthlyExpensesPage from './pages/MonthlyExpensesPage';

// Admin
import AdminUsersPage from './pages/admin/Users';
import DevToolsPage from './pages/admin/DevtoolsPage';
import VaultPage from './pages/VaultPage';


export default function App() {
  return (
    <UserProvider auth={auth} db={db}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage auth={auth} db={db} redirectTo="/" />} />
          <Route path="/not-authorized" element={
            <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-white">
              <div className="text-center">
                <p className="text-xl font-semibold mb-2">Acesso não autorizado</p>
                <p className="text-zinc-400 text-sm">Não tem permissões para aceder a esta área.</p>
              </div>
            </div>
          } />

          <Route
            path="/"
            element={
              <ProtectRoute requiredRole={Role.FinhubAdmin}>
                <DashboardLayout />
              </ProtectRoute>
            }
          >
            <Route index element={<DashboardPage />} />

            {/* Entity-scoped routes — entity comes from URL param */}
            <Route path=":entity">
              <Route path="accounts"     element={<AccountsPage />} />
              <Route path="income"       element={<IncomeSourcesPage />} />
              <Route path="ec-contracts" element={<EcContractsPage />} />
              <Route path="contracts"    element={<TeamPage />} />
              <Route path="payroll"      element={<Navigate to="../contracts" replace />} />
              <Route path="revenue"      element={<NoisyPhocusRevenuePage />} />
              <Route path="loans"        element={<LoansPage />} />
              <Route path="vat"          element={<VatPage />} />
              <Route path="costs"        element={<MonthlyExpensesPage />} />
              <Route path="irs"          element={<IRSPage />} />
              <Route path="recurring"    element={<RecurringPage />} />
              <Route path="credits"     element={<CreditsPage />} />
              <Route path="insurances"  element={<InsurancesPage />} />
              <Route path="forecast"     element={<ForecastPage />} />
              {/* Cash Flow was folded into Contas (balances are edited in the account form) */}
              <Route path="cashflow"     element={<Navigate to="../accounts" replace />} />
              <Route path="categories"   element={<CategoriesPage />} />
            </Route>

            {/* Vault */}
            <Route path="vault" element={<VaultPage />} />

            {/* Global admin/setup routes */}
            <Route path="setup/people"    element={<PeoplePage />} />
            <Route path="setup/companies" element={<CompaniesPage />} />
            <Route path="admin/access"    element={
              <ProtectRoute requiredRole={Role.Owner}><AdminUsersPage /></ProtectRoute>
            } />
            <Route path="admin/dev"       element={
              <ProtectRoute requiredRole={Role.Owner}><DevToolsPage /></ProtectRoute>
            } />

            {/* Legacy redirects */}
            <Route path="setup/accounts"     element={<Navigate to="/private/accounts" replace />} />
            <Route path="setup/contracts"    element={<Navigate to="/noisysource/contracts" replace />} />
            <Route path="setup/ec-contracts" element={<Navigate to="/noisysource/ec-contracts" replace />} />
            <Route path="irs"                element={<Navigate to="/private/irs" replace />} />
            <Route path="recurring"          element={<Navigate to="/noisysource/recurring" replace />} />
            <Route path="forecast"           element={<Navigate to="/noisysource/forecast" replace />} />
            <Route path="cashflow"           element={<Navigate to="/noisysource/accounts" replace />} />
            <Route path="categories"         element={<Navigate to="/noisysource/categories" replace />} />
            <Route path="revenue"            element={<Navigate to="/noisysource/ec-contracts" replace />} />
            <Route path="payroll"            element={<Navigate to="/noisysource/contracts" replace />} />
            <Route path="employment/contracts" element={<Navigate to="/noisysource/contracts" replace />} />
            <Route path="employment/payroll"   element={<Navigate to="/noisysource/contracts" replace />} />
            <Route path="admin/people"         element={<Navigate to="/setup/people" replace />} />
            <Route path="admin/companies"      element={<Navigate to="/setup/companies" replace />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </UserProvider>
  );
}
