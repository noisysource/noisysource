import { Routes, Route, BrowserRouter, Navigate } from 'react-router-dom';
import { ProtectRoute } from '@shared/ProtectedRoute';
import NotAuthorizedPage from './pages/NotAuthorizedPage';
import LandingPage from './pages/LandingPage';
import { Role } from '@shared/models/Roles';
import LoginPage from '@shared/Login';
import { auth, db } from './lib/firebase';
import { Analytics } from './components/Analytics';

// New Admin Layout and Pages
import AdminLayout from './pages/admin/AdminLayout';
import PartyAdminPage from './pages/admin/PartyAdminPage';
import PartyConfigPage from './pages/admin/PartyConfigPage';
import StudyRoomPage from './pages/admin/StudyRoomPage';
import StudyPricingPage from './pages/admin/StudyPricingPage';
import CalendarPage from './pages/admin/CalendarPage';
import EmailCenterPage from './pages/admin/EmailCenterPage';
import TransportationPage from './pages/admin/transport/TransportationPage';
import TransportationConfigPage from './pages/admin/transport/TransportationConfigPage';
import FeatureFlagsPage from './pages/admin/FeatureFlagsPage';
import CampAdminPage from './pages/admin/CampAdminPage';
import DashboardPage from './pages/admin/DashboardPage';
import IncomesPage from './pages/admin/IncomesPage';
import ExpensesPage from './pages/admin/ExpensesPage';
import EditEmployeePage from './pages/admin/EditEmployeePage';
import TimesheetsPage from './pages/admin/TimesheetsPage';
import DataManagementPage from './pages/admin/DataManagementPage';
import HRPage from './pages/admin/HRPage';

import ClientLayout from './pages/client/ClientLayout';
import FamilyDashboardPage from './pages/client/FamilyDashboardPage';
import ChildManagementPage from './pages/client/ChildManagementPage';
import ChildDetailPage from './pages/client/ChildDetailPage';
import EventCalendarPage from './pages/client/EventCalendarPage';
import FamilySchedulePage from './pages/client/FamilySchedulePage';
import FamilyInvoicePage from './pages/client/FamilyInvoicePage';
import StudySubscriptionDetailPage from './pages/client/StudySubscriptionDetailPage';
import TransportSubscriptionDetailPage from './pages/client/TransportSubscriptionDetailPage';
import ClientSchedulePage from './pages/client/ClientSchedulePage';
import InvoiceListPage from './pages/client/InvoiceListPage';
import InvoiceDetailPage from './pages/client/InvoiceDetailPage';
import PaymentHistoryPage from './pages/client/PaymentHistoryPage';

export default function App() {
  return (
    <BrowserRouter>
      <Analytics />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage auth={auth} db={db} />} />

        {/* New Admin Route Structure */}
        <Route
          path="/admin"
          element={
            <ProtectRoute requiredRole={Role.RainbowAdmin}>
              <AdminLayout />
            </ProtectRoute>
          }
        >
          <Route index element={<Navigate to="/admin/parties" replace />} />
          <Route path="parties" element={<PartyAdminPage />} />
          <Route path="party-config" element={<PartyConfigPage />} />
          <Route path="study-room" element={<StudyRoomPage />} />
          <Route path="study-pricing" element={<StudyPricingPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="email-center" element={<EmailCenterPage />} />
          <Route path="transport" element={<TransportationPage />} />
          <Route path="transport-config" element={<TransportationConfigPage />} />
          <Route path="feature-flags" element={<FeatureFlagsPage />} />
          <Route path="camp" element={<CampAdminPage />} />
          
          {/* Owner-only routes */}
          <Route path="dashboard" element={<ProtectRoute requiredRole={Role.Owner}><DashboardPage /></ProtectRoute>} />
          <Route path="incomes" element={<ProtectRoute requiredRole={Role.Owner}><IncomesPage /></ProtectRoute>} />
          <Route path="expenses" element={<ProtectRoute requiredRole={Role.Owner}><ExpensesPage /></ProtectRoute>} />
          <Route path="hr" element={<ProtectRoute requiredRole={Role.Owner}><HRPage /></ProtectRoute>} />
          <Route path="hr/edit/:employeeId" element={<ProtectRoute requiredRole={Role.Owner}><EditEmployeePage /></ProtectRoute>} />
          <Route path="timesheets" element={<ProtectRoute requiredRole={Role.Owner}><TimesheetsPage /></ProtectRoute>} />
          <Route path="data-management" element={<ProtectRoute requiredRole={Role.Owner}><DataManagementPage /></ProtectRoute>} />
        </Route>

        {/* Client Area - Family-Centric */}
        <Route
          path="/client"
          element={
            <ProtectRoute>
              <ClientLayout />
            </ProtectRoute>
          }
        >
          {/* New Family Dashboard */}
          <Route index element={<FamilyDashboardPage />} />
          
          {/* Family Management */}
          <Route path="family/schedule" element={<FamilySchedulePage />} />
          <Route path="family/invoices" element={<FamilyInvoicePage />} />
          <Route path="family/payments" element={<PaymentHistoryPage />} />
          
          {/* Children Management */}
          <Route path="children" element={<ChildManagementPage />} />
          <Route path="children/:childId" element={<ChildDetailPage />} />
          <Route path="children/:childId/calendar" element={<EventCalendarPage />} />
          
          {/* Legacy/Individual Routes (for backwards compatibility during migration) */}
          <Route path="schedule" element={<ClientSchedulePage />} />
          <Route path="study/:id" element={<StudySubscriptionDetailPage />} />
          <Route path="transport/:id" element={<TransportSubscriptionDetailPage />} />
          <Route path="invoices" element={<InvoiceListPage />} />
          <Route path="invoices/:id" element={<InvoiceDetailPage />} />
        </Route>

        <Route path="/not-authorized" element={<NotAuthorizedPage />} />
        <Route path="*" element={<div>Not found</div>} />
      </Routes>
    </BrowserRouter>
  );
}