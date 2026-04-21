import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

type Org = { id: string; name: string };
type OrgContextValue = { orgId: string; setOrgId: (id: string) => void; orgs: Org[] };

const Ctx = createContext<OrgContextValue | null>(null);
const LS_KEY = "finhub:activeOrgId";

export const OrgProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [orgs] = useState<Org[]>([
    { id: "personal", name: "Personal" },
    { id: "noisysource", name: "NoisySource" },
    { id: "noisyphocus", name: "NoisyPhocus" },
  ]);
  const [orgId, setOrgIdState] = useState<string>(() => localStorage.getItem(LS_KEY) || "personal");
  const setOrgId = (id: string) => { setOrgIdState(id); localStorage.setItem(LS_KEY, id); };
  useEffect(() => { if (!localStorage.getItem(LS_KEY)) localStorage.setItem(LS_KEY, orgId); }, [orgId]);
  const value = useMemo(() => ({ orgId, setOrgId, orgs }), [orgId, orgs]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useOrg = () => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useOrg must be used within OrgProvider");
  return ctx;
};