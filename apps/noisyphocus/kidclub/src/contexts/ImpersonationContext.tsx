import { createContext, useContext, useState, useEffect } from 'react';
import { setFamilyServiceImpersonation } from '../services/familyService';

export interface ImpersonationState {
  familyId: string;
  contactName: string;
}

interface ImpersonationContextValue {
  impersonation: ImpersonationState | null;
  startImpersonation: (state: ImpersonationState) => void;
  stopImpersonation: () => void;
}

const ImpersonationContext = createContext<ImpersonationContextValue>({
  impersonation: null,
  startImpersonation: () => {},
  stopImpersonation: () => {},
});

const SESSION_KEY = 'kidclub_impersonate';

export function ImpersonationProvider({ children }: { children: React.ReactNode }) {
  const [impersonation, setImpersonation] = useState<ImpersonationState | null>(() => {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      return stored ? (JSON.parse(stored) as ImpersonationState) : null;
    } catch {
      return null;
    }
  });

  // Keep familyService in sync whenever impersonation changes
  useEffect(() => {
    setFamilyServiceImpersonation(impersonation);
  }, [impersonation]);

  const startImpersonation = (state: ImpersonationState) => {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(state)); } catch { /* ignore */ }
    setImpersonation(state);
  };

  const stopImpersonation = () => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    setImpersonation(null);
  };

  return (
    <ImpersonationContext.Provider value={{ impersonation, startImpersonation, stopImpersonation }}>
      {children}
    </ImpersonationContext.Provider>
  );
}

export function useImpersonation() {
  return useContext(ImpersonationContext);
}
