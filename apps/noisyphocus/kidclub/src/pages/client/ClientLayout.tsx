import { useState, useEffect } from 'react';
import { Outlet, useLocation, Navigate, useNavigate } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import Header from '../../components/Header';
import ClientSidebar from '../../components/client/ClientSidebar';
import { familyService } from '../../services/familyService';
import { Family } from '@shared/models';
import FamilyProfileSetupPage from './FamilyProfileSetupPage';
import ClaimSubscriptionsPage from './ClaimSubscriptionsPage';
import { useImpersonation } from '../../contexts/ImpersonationContext';

export default function ClientLayout() {
  const user = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const { impersonation, stopImpersonation } = useImpersonation();
  const [family, setFamily] = useState<Family | null>(null);
  const [hasUnclaimed, setHasUnclaimed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (!user) return;
    const check = async () => {
      try {
        const fam = await familyService.getOrCreateFamily(
          user.uid,
          user.name || user.email?.split('@')[0] || '',
          user.email || ''
        );
        setFamily(fam);

        // Check for admin-created subscriptions linked by email but not yet claimed
        if (user.email && fam.profileComplete) {
          try {
            setHasUnclaimed(await familyService.hasUnclaimedSubscriptions(user.email));
          } catch {
            // Silently ignore — non-blocking
          }
        }
      } catch (err) {
        console.error('ClientLayout check error:', err);
      } finally {
        setChecking(false);
      }
    };
    check();
  }, [user]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        A carregar...
      </div>
    );
  }

  // First-time users: family profile setup (skip when admin is impersonating)
  if (family && !family.profileComplete && !impersonation) {
    return (
      <FamilyProfileSetupPage
        family={family}
        onComplete={() => {
          setChecking(true);
          familyService.getOrCreateFamily(
            user!.uid,
            user!.name || user!.email?.split('@')[0] || '',
            user!.email || ''
          ).then(async fam => {
            setFamily(fam);
            // Check for unclaimed subscriptions after profile is complete
            if (user?.email) {
              try {
                setHasUnclaimed(await familyService.hasUnclaimedSubscriptions(user.email));
              } catch { /* non-blocking */ }
            }
            setChecking(false);
          });
        }}
      />
    );
  }

  // Admin-created subscriptions waiting to be claimed (skip when admin is impersonating)
  if (hasUnclaimed && !impersonation) {
    return (
      <ClaimSubscriptionsPage onComplete={() => setHasUnclaimed(false)} />
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {impersonation && (
        <div className="bg-amber-400 text-amber-900 text-sm font-medium px-4 py-2 flex items-center justify-between shrink-0 z-50">
          <span>👁 A ver como <strong>{impersonation.contactName}</strong></span>
          <button
            onClick={() => { stopImpersonation(); navigate('/admin/families'); }}
            className="ml-4 px-3 py-0.5 bg-amber-900 text-amber-50 rounded-lg text-xs font-semibold hover:bg-amber-800 transition-colors"
          >
            Sair
          </button>
        </div>
      )}
      <Header onMenuClick={() => setSidebarOpen(true)} />
      <div className="flex flex-1 min-h-0">
        <ClientSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden p-4 md:p-6 bg-gray-50">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
