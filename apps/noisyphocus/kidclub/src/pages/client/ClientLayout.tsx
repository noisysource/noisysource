import { useState, useEffect } from 'react';
import { Outlet, useLocation, Navigate } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import Header from '../../components/Header';
import ClientSidebar from '../../components/client/ClientSidebar';
import { familyService } from '../../services/familyService';
import { Family } from '@shared/models';
import FamilyProfileSetupPage from './FamilyProfileSetupPage';

export default function ClientLayout() {
  const user = useUser();
  const location = useLocation();
  const [family, setFamily] = useState<Family | null>(null);
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

  // First-time users: show setup page without sidebar/header chrome
  if (family && !family.profileComplete) {
    return (
      <FamilyProfileSetupPage
        family={family}
        onComplete={() => {
          // Re-fetch from Firestore to ensure we have the saved state
          setChecking(true);
          familyService.getOrCreateFamily(
            user!.uid,
            user!.name || user!.email?.split('@')[0] || '',
            user!.email || ''
          ).then(fam => { setFamily(fam); setChecking(false); });
        }}
      />
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
