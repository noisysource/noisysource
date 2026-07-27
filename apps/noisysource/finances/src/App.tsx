import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { UserProvider } from '@shared/hooks';
import { EntityProvider } from './hooks/EntityContext';
import { auth, db } from './lib/firebase';

import DashboardLayout from './components/layout/DashboardLayout';
import { ProtectRoute } from '@shared/ProtectedRoute';
import { Role } from '@shared/models/Roles';
import LoginPage from '@shared/Login';

// Setup
import PeoplePage from './pages/admin/PeoplePage';
import CompaniesPage from './pages/admin/CompaniesPage';
import AccountsPage from './pages/AccountsPage';
import ContractsPage from './pages/EmploymentContractsPage';
import EcContractsPage from './pages/EcContractsPage';

// Finance
import RecurringPage from './pages/RecurringPage';
import ForecastPage from './pages/ForecastPage';
import CashFlowPage from './pages/CashFlowPage';
import IRSPage from './pages/IRSPage';
import CategoriesPage from './pages/CategoriesPage';
import PayrollPage from './pages/PayrollPage';

// Admin
import AdminUsersPage from './pages/admin/Users';
import DevToolsPage from './pages/admin/DevtoolsPage';

export default function App() {
  return (
    <UserProvider auth={auth} db={db}>
      <EntityProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage auth={auth} db={db} />} />

            <Route
              path="/"
              element={
                <ProtectRoute requiredRole={Role.FinhubAdmin}>
                  <DashboardLayout />
                </ProtectRoute>
              }
            >
              <Route index element={<Navigate to="/recurring" replace />} />

              {/* Setup */}
              <Route path="setup/people" element={<PeoplePage />} />
              <Route path="setup/companies" element={<CompaniesPage />} />
              <Route path="setup/accounts" element={<AccountsPage />} />
              <Route path="setup/contracts" element={<ContractsPage />} />
              <Route path="setup/ec-contracts" element={<EcContractsPage />} />

              {/* Finance */}
              <Route path="recurring" element={<RecurringPage />} />
              <Route path="forecast" element={<ForecastPage />} />
              <Route path="cashflow" element={<CashFlowPage />} />
              <Route path="irs" element={<IRSPage />} />
              <Route path="categories" element={<CategoriesPage />} />
              <Route path="payroll" element={<PayrollPage />} />

              {/* Admin */}
              <Route
                path="admin/access"
                element={
                  <ProtectRoute requiredRole={Role.Owner}>
                    <AdminUsersPage />
                  </ProtectRoute>
                }
              />
              <Route
                path="admin/dev"
                element={
                  <ProtectRoute requiredRole={Role.Owner}>
                    <DevToolsPage />
                  </ProtectRoute>
                }
              />

              {/* Legacy redirects */}
              <Route path="accounts" element={<Navigate to="/setup/accounts" replace />} />
              <Route path="revenue" element={<Navigate to="/setup/ec-contracts" replace />} />
              <Route path="employment/contracts" element={<Navigate to="/setup/contracts" replace />} />
              <Route path="employment/payroll" element={<Navigate to="/payroll" replace />} />
              <Route path="admin/people" element={<Navigate to="/setup/people" replace />} />
              <Route path="admin/companies" element={<Navigate to="/setup/companies" replace />} />
            </Route>

            <Route path="*" element={<Navigate to="/recurring" replace />} />
          </Routes>
        </BrowserRouter>
      </EntityProvider>
    </UserProvider>
  );
}
