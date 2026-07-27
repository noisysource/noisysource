import type { Account } from "@shared/models/Account";

type Company = { id: string; name: string; shortCode?: string };
type Person  = { id: string; name: string };

export function AccountsTable({
  items,
  companies,
  people,
  onEdit,
  onDelete,
  loading,
}: {
  items: Account[];
  companies: Company[];
  people: Person[];
  onEdit: (acc: Account) => void;
  onDelete: (id: string) => Promise<void>;
  loading?: boolean;
}) {
  const ownerName = (a: Account) => {
    const ot = (a as any).ownerType;
    const oid = (a as any).ownerId;
    if (ot === "company") return companies.find(c => c.id === oid)?.name || "—";
    if (ot === "person")  return people.find(p => p.id === oid)?.name || "—";
    return "—";
  };

  const meta = (a: Account) => {
    switch (a.type) {
      case "bank":
        return [a.bankName, (a as any).iban, (a as any).bic].filter(Boolean).join(" · ");
      case "credit":
        return [(a as any).issuer, (a as any).last4 ? `•••• ${(a as any).last4}` : ""].filter(Boolean).join(" · ");
      case "voucher":
        return [(a as any).voucherType, (a as any).issuingEmployer].filter(Boolean).join(" · ");
      case "bonds":
        return (a as any).provider || "";
      default:
        return "";
    }
  };

  return (
    <table className="min-w-full text-sm text-left">
      <thead>
        <tr className="border-b border-zinc-700">
          <th className="px-3 py-2">Code</th>
          <th className="px-3 py-2">Name</th>
          <th className="px-3 py-2">Type</th>
          <th className="px-3 py-2">Owner</th>
          <th className="px-3 py-2">Meta</th>
          <th className="px-3 py-2"></th>
        </tr>
      </thead>
      <tbody>
        {items.map((a) => (
          <tr key={a.id} className="border-b border-zinc-800">
            <td className="px-3 py-2">{a.code || "—"}</td>
            <td className="px-3 py-2">{a.name}</td>
            <td className="px-3 py-2">{a.type}</td>
            <td className="px-3 py-2">{ownerName(a)}</td>
            <td className="px-3 py-2">{meta(a) || "—"}</td>
            <td className="px-3 py-2 space-x-2">
              <button className="text-blue-400 underline" onClick={() => onEdit(a)}>Edit</button>
              <button
                className="text-red-400 underline"
                onClick={() => onDelete(a.id)}
                disabled={loading}
              >
                Delete
              </button>
            </td>
          </tr>
        ))}
        {!items.length && (
          <tr>
            <td colSpan={6} className="px-3 py-6 text-zinc-500">
              {loading ? "Loading…" : "No accounts yet."}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}