import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { api } from '../lib/api';

type Org = { id: string; name: string };

interface OrgContextType {
  orgs: Org[];
  selectedOrgId: string;
  setSelectedOrgId: (orgId: string) => void;
  loading: boolean;
}

const OrgContext = createContext<OrgContextType | undefined>(undefined);

export const OrgProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string>('personal');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.companies.list()
      .then(companies => {
        const allOrgs = [{ id: 'personal', name: 'Personal' }, ...companies];
        setOrgs(allOrgs);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    api.setOrg(selectedOrgId);
  }, [selectedOrgId]);

  const value = useMemo(() => ({
    orgs,
    selectedOrgId,
    setSelectedOrgId,
    loading,
  }), [orgs, selectedOrgId, loading]);

  return (
    <OrgContext.Provider value={value}>
      {children}
    </OrgContext.Provider>
  );
};

export const useOrgs = () => {
  const context = useContext(OrgContext);
  if (context === undefined) {
    throw new Error('useOrgs must be used within an OrgProvider');
  }
  return context;
};
