import { Routes, Route, BrowserRouter, Navigate } from 'react-router-dom';
import { ImpersonationProvider } from './contexts/ImpersonationContext';
import { ProtectRoute } from '@shared/ProtectedRoute';
import NotAuthorizedPage from './pages/NotAuthorizedPage';
import LandingPage from './pages/LandingPage';
import { Role } from '@shared/models/Roles';
import LoginPage from '@shared/Login';
import { auth, db } from './lib/firebase';
import { Analytics } from './components/Analytics';

// Admin pages
import AdminLayout from './pages/admin/AdminLayout';
import PartyAdminPage from './pages/admin/PartyAdminPage';
import PartyConfigPage from './pages/admin/PartyConfigPage';
import FinancialSummaryPage from './pages/admin/FinancialSummaryPage';
import CalendarPage from './pages/admin/CalendarPage';
import EmailCenterPage from './pages/admin/EmailCenterPage';
import TransportationConfigPage from './pages/admin/transport/TransportationConfigPage';
import CampAdminPage from './pages/admin/CampAdminPage';
import CampsAdminPage from './pages/admin/CampsAdminPage';
import EditEmployeePage from './pages/admin/EditEmployeePage';
import TimesheetsPage from './pages/admin/TimesheetsPage';
import DataManagementPage from './pages/admin/DataManagementPage';
import HRPage from './pages/admin/HRPage';
import SubscriptionsAdminPage from './pages/admin/SubscriptionsAdminPage';
import TransportPlannerPage from './pages/admin/TransportPlannerPage';
import StudyRoomPlannerPage from './pages/admin/StudyRoomPlannerPage';
import BillingAdminPage from './pages/admin/BillingAdminPage';
import FamiliesAdminPage from './pages/admin/FamiliesAdminPage';
import DiscountsAdminPage from './pages/admin/DiscountsAdminPage';
import PaymentsPage from './pages/client/PaymentsPage';

// Client pages
import ClientLayout from './pages/client/ClientLayout';
import FamilyDashboardPage from './pages/client/FamilyDashboardPage';
import ChildManagementPage from './pages/client/ChildManagementPage';
import ChildDetailPage from './pages/client/ChildDetailPage';
import EventCalendarPage from './pages/client/EventCalendarPage';
import FamilySchedulePage from './pages/client/FamilySchedulePage';
import StudySubscriptionDetailPage from './pages/client/StudySubscriptionDetailPage';
import TransportSubscriptionDetailPage from './pages/client/TransportSubscriptionDetailPage';
import ClientSchedulePage from './pages/client/ClientSchedulePage';
import MySubscriptionsPage from './pages/client/MySubscriptionsPage';
import AccountPage from './pages/client/AccountPage';
import InvoiceListPage from './pages/client/InvoiceListPage';
import InvoiceDetailPage from './pages/client/InvoiceDetailPage';
import StudyRoomEnrollPage from './pages/client/enrollment/StudyRoomEnrollPage';
import TransportEnrollPage from './pages/client/enrollment/TransportEnrollPage';
import PartyListPage from './pages/client/parties/PartyListPage';
import PartyBookingPage from './pages/client/parties/PartyBookingPage';
import PartyDetailPage from './pages/client/parties/PartyDetailPage';
import ClientCampsPage from './pages/client/camps/ClientCampsPage';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage';
import TermsPage from './pages/TermsPage';

export default function App() {
  return (
    <BrowserRouter>
      <ImpersonationProvider>
      <Analytics />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage auth={auth} db={db} />} />

        {/* Admin */}
        <Route
          path="/admin"
          element={
            <ProtectRoute requiredRole={Role.RainbowAdmin}>
              <AdminLayout />
            </ProtectRoute>
          }
        >
          <Route index element={<Navigate to="/admin/subscriptions" replace />} />
          <Route path="subscriptions" element={<SubscriptionsAdminPage />} />
          <Route path="parties" element={<PartyAdminPage />} />
          <Route path="party-config" element={<PartyConfigPage />} />
          <Route path="study-pricing" element={<Navigate to="/admin/financial-summary" replace />} />
          <Route path="financial-summary" element={<FinancialSummaryPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="email-center" element={<EmailCenterPage />} />
          <Route path="transport-config" element={<TransportationConfigPage />} />
          <Route path="transport-planner" element={<TransportPlannerPage />} />
          <Route path="camp" element={<CampAdminPage />} />
          <Route path="camps" element={<CampsAdminPage />} />
          <Route path="billing" element={<BillingAdminPage />} />
          <Route path="families" element={<FamiliesAdminPage />} />
          <Route path="config/descontos" element={<DiscountsAdminPage />} />
          {/* Legacy redirects */}
          <Route path="study-room-planner" element={<StudyRoomPlannerPage />} />
          <Route path="study-room" element={<Navigate to="/admin/subscriptions" replace />} />
          <Route path="transport" element={<Navigate to="/admin/subscriptions" replace />} />
          <Route path="enrollments" element={<Navigate to="/admin/subscriptions" replace />} />

          {/* Owner-only */}
          <Route path="hr" element={<ProtectRoute requiredRole={Role.Owner}><HRPage /></ProtectRoute>} />
          <Route path="hr/edit/:employeeId" element={<ProtectRoute requiredRole={Role.Owner}><EditEmployeePage /></ProtectRoute>} />
          <Route path="timesheets" element={<ProtectRoute requiredRole={Role.Owner}><TimesheetsPage /></ProtectRoute>} />
          <Route path="data-management" element={<DataManagementPage />} />
        </Route>

        {/* Client portal */}
        <Route
          path="/client"
          element={
            <ProtectRoute>
              <ClientLayout />
            </ProtectRoute>
          }
        >
          <Route index element={<FamilyDashboardPage />} />

          {/* Children */}
          <Route path="children" element={<ChildManagementPage />} />
          <Route path="children/:childId" element={<ChildDetailPage />} />
          <Route path="children/:childId/calendar" element={<EventCalendarPage />} />

          {/* Subscriptions */}
          <Route path="subscriptions" element={<MySubscriptionsPage />} />
          <Route path="enroll/study" element={<StudyRoomEnrollPage />} />
          <Route path="enroll/transport" element={<TransportEnrollPage />} />

          {/* Invoices & payments */}
          <Route path="invoices" element={<InvoiceListPage />} />
          <Route path="invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="payments" element={<PaymentsPage />} />

          {/* Account */}
          <Route path="account" element={<AccountPage />} />

          {/* Parties */}
          <Route path="parties" element={<PartyListPage />} />
          <Route path="parties/new" element={<PartyBookingPage />} />
          <Route path="parties/:id" element={<PartyDetailPage />} />

          {/* Camps */}
          <Route path="camps" element={<ClientCampsPage />} />

          {/* Legacy compat */}
          <Route path="family/schedule" element={<FamilySchedulePage />} />
          <Route path="schedule" element={<ClientSchedulePage />} />
          <Route path="study/:id" element={<StudySubscriptionDetailPage />} />
          <Route path="transport/:id" element={<TransportSubscriptionDetailPage />} />
        </Route>

        <Route path="/privacy" element={<PrivacyPolicyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/not-authorized" element={<NotAuthorizedPage />} />
        <Route path="*" element={<div className="p-8 text-center text-gray-500">Página não encontrada</div>} />
      </Routes>
      </ImpersonationProvider>
    </BrowserRouter>
  );
}
