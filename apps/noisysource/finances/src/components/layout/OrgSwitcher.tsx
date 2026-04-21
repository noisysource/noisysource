import { useOrg } from "@shared/context/OrgContext";

type Props = { className?: string };

export default function OrgSwitcher({ className = "" }: Props) {
  const { orgId, setOrgId, orgs } = useOrg();

  return (
    <div className={`mb-4 ${className}`}>
      <label className="block text-xs text-zinc-400 mb-1">Organization</label>
      <select
        value={orgId}
        onChange={(e) => setOrgId(e.target.value)}
        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} — {o.id}
          </option>
        ))}
      </select>
    </div>
  );
}