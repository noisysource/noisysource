import { useOrgs } from '../../hooks/OrgContext';

export function OrgSelector() {
  const { orgs, selectedOrgId, setSelectedOrgId, loading } = useOrgs();

  if (loading) {
    return <div className="text-sm text-zinc-400">Loading orgs...</div>;
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="org-selector" className="text-sm font-medium text-zinc-400">Organization:</label>
      <select
        id="org-selector"
        value={selectedOrgId}
        onChange={(e) => setSelectedOrgId(e.target.value)}
        className="bg-zinc-800 border border-zinc-700 text-white rounded px-2 py-1 text-sm"
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}
