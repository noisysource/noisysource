import { useState, useEffect } from 'react';
import { Outlet, useLocation, Navigate } from 'react-router-dom';
import { getDocs, query, where } from 'firebase/firestore';
import { useUser } from '@shared/hooks';
import Header from '../../components/Header';
import ClientSidebar from '../../components/client/ClientSidebar';
import { familyService } from '../../services/familyService';
import { col } from '../../lib/db';
import { Family } from '@shared/models';
import FamilyProfileSetupPage from './FamilyProfileSetupPage';
import ClaimSubscriptionsPage from './ClaimSubscriptionsPage';

export default function ClientLayout() {
  const user = useUser();
  const location = useLocation();
  const [family, setFamily] = useState<Family | null>(null);
  const [hasUnclaimed, setHasUnclaimed] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!user) return;
    const check = async () => {
      const fam = await familyService.getOrCreateFamily(
        user.uid,
        user.name || user.email?.split('@')[0] || '',
        user.email || ''
      );
      setFamily(fam);

      // Check for admin-created subscriptions linked by email but not yet claimed
      if (user.email && fam.profileComplete) {
        try {
          const snap = await getDocs(
            query(col('transportationSubscriptions'), where('contactEmail', '==', user.email))
          );
          setHasUnclaimed(snap.docs.some(d => !d.data().familyId && d.data().status !== 'cancelled'));
        } catch {
          // Silently ignore — non-blocking
        }
      }

      setChecking(false);
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

  // First-time users: family profile setup
  if (family && !family.profileComplete) {
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
                const snap = await getDocs(
                  query(col('transportationSubscriptions'), where('contactEmail', '==', user.email))
                );
                setHasUnclaimed(snap.docs.some(d => !d.data().familyId && d.data().status !== 'cancelled'));
              } catch { /* non-blocking */ }
            }
            setChecking(false);
          });
        }}
      />
    );
  }

  // Admin-created subscriptions waiting to be claimed
  if (hasUnclaimed) {
    return (
      <ClaimSubscriptionsPage onComplete={() => setHasUnclaimed(false)} />
    );
  }

  return (
    <>
      <Header />
      <div className="min-h-screen flex">
        <ClientSidebar />
        <main className="flex-1 p-6 bg-gray-50 overflow-auto">
          <Outlet />
        </main>
      </div>
    </>
  );
}
