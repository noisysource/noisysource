import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { UserProvider } from '@shared/hooks';
import { OrgProvider } from './hooks/OrgContext';
import { auth, db } from './lib/firebase';

import AccountsPage from './pages/AccountsPage';
import AdminUsersPage from './pages/admin/Users';
import PeoplePage from './pages/admin/PeoplePage';
import CompaniesPage from './pages/admin/CompaniesPage';

import DashboardLayout from './components/layout/DashboardLayout';
import { ProtectRoute } from '@shared/ProtectedRoute';
import { Role } from '@shared/models/Roles';

import LoginPage from '@shared/Login';

import TemplateManagerPage from './pages/TemplateManagerPage';
import PlannedInstancesPage from './pages/PlannedInstancePage';
import LedgerPage from './pages/LedgerPage';
import CategoriesPage from './pages/CategoriesPage';
import DevToolsPage from './pages/admin/DevtoolsPage';
import ContractsPage from './pages/EmploymentContractsPage';
import PayrollPage from './pages/PayrollPage';
import BalancesPage from './pages/BalancesPages';

export default function App() {
  return (
    <UserProvider auth={auth} db={db}>
      <OrgProvider>
        <BrowserRouter>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage auth={auth} db={db} />} />

            {/* Protected app shell */}
            <Route
              path="/"
              element={
                <ProtectRoute requiredRole={Role.FinhubAdmin}>
                  <DashboardLayout />
                </ProtectRoute>
              }
            >
              <Route
                path="/admin/dev"
                element={
                  <ProtectRoute requiredRole={Role.Owner}>
                    <DevToolsPage />
                  </ProtectRoute>
                }
              />
              {/* Default -> /forecast */}
              <Route index element={<Navigate to="/" replace />} />

              {/* Core finance */}
              <Route path="/ledger" element={<LedgerPage />} />
              <Route path="accounts" element={<AccountsPage />} />
              <Route path="/categories" element={<CategoriesPage />} />
              <Route path="templates" element={<TemplateManagerPage />} />
              <Route path="planned" element={<PlannedInstancesPage />} />
              <Route path="/employment/contracts" element={<ContractsPage />} />
              <Route path="/employment/payroll" element={<PayrollPage />} />
              <Route path="/balances" element={<BalancesPage />} />

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
                path="admin/people"
                element={
                  <ProtectRoute requiredRole={Role.Owner}>
                    <PeoplePage />
                  </ProtectRoute>
                }
              />
              <Route
                path="admin/companies"
                element={
                  <ProtectRoute requiredRole={Role.Owner}>
                    <CompaniesPage />
                  </ProtectRoute>
                }
              />
            </Route>

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/forecast" replace />} />
          </Routes>
        </BrowserRouter>
      </OrgProvider>
    </UserProvider>
  );
}