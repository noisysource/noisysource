// apps/finhub/src/components/accounts/AccountForm.tsx
import { useEffect, useMemo, useState } from "react";
import type { Account, AccountType, OwnerType, VoucherType } from "@shared/models/Account";
import { cleanUndefined } from "@shared/lib/clean";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { api } from "../../lib/api";
import { useAccountsData } from "../../hooks/useAccountData";

const initials = (s: string) =>
  (s || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("");

const slug = (s: string) =>
  (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function AccountForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: Account | null;
  onSaved?: () => Promise<void> | void;
  onCancel: () => void;
}) {
  // shared owners data (companies/people) from hook
  const { companies, people, reload, loading } = useAccountsData();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [ownerType, setOwnerType] = useState<OwnerType | "">("");
  const [ownerId, setOwnerId] = useState("");
  const [jointOwnerIds, setJointOwnerIds] = useState<string[]>([]);
  const [type, setType] = useState<AccountType>("bank");
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<"EUR">("EUR");

  // bank
  const [bankName, setBankName] = useState("");
  const [iban, setIban] = useState("");
  const [bic, setBic] = useState("");

  // credit
  const [issuer, setIssuer] = useState("");
  const [last4, setLast4] = useState("");

  // voucher
  const [voucherType, setVoucherType] = useState<VoucherType>("meal");
  const [voucherProvider, setVoucherProvider] = useState("Edenred");
  const [issuingEmployer, setIssuingEmployer] = useState("");
  const [monthlyTopUp, setMonthlyTopUp] = useState("");

  // bonds
  const [bondsProvider, setBondsProvider] = useState("CTT");

  useEffect(() => {
    if (!initial) {
      setEditingId(null);
      setOwnerType("");
      setOwnerId("");
      setJointOwnerIds([]);
      setType("bank");
      setName("");
      setCurrency("EUR");
      setBankName("");
      setIban("");
      setBic("");
      setIssuer("");
      setLast4("");
      setVoucherType("meal");
      setVoucherProvider("Edenred");
      setIssuingEmployer("");
      setMonthlyTopUp("");
      setBondsProvider("CTT");
      return;
    }
    setEditingId(initial.id);
    setOwnerType((initial as any).ownerType || "");
    setOwnerId((initial as any).ownerId || "");
    setJointOwnerIds((initial as any).jointOwnerIds || []);
    setType(initial.type);
    setName(initial.name || "");
    setCurrency(((initial as any).currency as "EUR") || "EUR");
    setBankName((initial as any).bankName || "");
    setIban((initial as any).iban || "");
    setBic((initial as any).bic || "");
    setIssuer((initial as any).issuer || "");
    setLast4((initial as any).last4 || "");
    setVoucherType((initial as any).voucherType || "meal");
    setVoucherProvider((initial as any).provider || "Edenred");
    setIssuingEmployer((initial as any).issuingEmployer || "");
    setMonthlyTopUp((initial as any).monthlyTopUpCents ? String((initial as any).monthlyTopUpCents / 100) : "");
    setBondsProvider((initial as any).provider || "CTT");
  }, [initial]);

  // owner token → lower-case; company prefers shortCode, person uses initials
  const ownerToken = useMemo(() => {
    if (ownerType === "company") {
      const c = companies.find((x) => x.id === ownerId);
      const raw = c?.shortCode || initials(c?.name || "");
      return slug(raw);
    }
    if (ownerType === "person") {
      const p = people.find((x) => x.id === ownerId);
      return slug(initials(p?.name || ""));
    }
    return "";
  }, [ownerType, ownerId, companies, people]);

  // final auto code: owner:type:name
  const codePreview = useMemo(() => {
    const parts = [ownerToken, type, slug(name || `${type} account`)].filter(Boolean);
    return parts.join(":");
  }, [ownerToken, type, name]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!ownerType || !ownerId) return;

    const base = cleanUndefined({
      id: editingId || undefined,
      code: codePreview,
      name: name.trim() || `${type.toUpperCase()} Account`,
      type,
      ownerType,
      ownerId,
      jointOwnerIds: jointOwnerIds.length ? jointOwnerIds : undefined,
      currency,
      createdAt: new Date(),
    });

    const topUpCents = monthlyTopUp ? Math.round(parseFloat(monthlyTopUp) * 100) : undefined;
    const payload =
      type === "bank"
        ? cleanUndefined({ ...base, bankName: bankName || undefined, iban: iban || undefined, bic: bic || undefined })
        : type === "credit"
        ? cleanUndefined({ ...base, issuer: issuer || undefined, last4: last4 || undefined })
        : type === "voucher"
        ? cleanUndefined({
            ...base,
            voucherType,
            provider: voucherProvider || undefined,
            issuingEmployer: issuingEmployer || undefined,
            monthlyTopUpCents: topUpCents,
          })
        : type === "bonds"
        ? cleanUndefined({ ...base, provider: bondsProvider || undefined })
        : base;

    await api.accounts.save(payload as any);
    await reload();
    await onSaved?.();
  }

  const submitDisabled = loading || !ownerType || !ownerId || !name.trim();

  return (
    <form onSubmit={handleSave} className="space-y-3">
      <div className="text-xs text-zinc-400">{loading ? "Loading owners…" : "\u00A0"}</div>

      <div>
        <div className="text-xs text-zinc-400 mb-1">Owner</div>
        <div className="grid grid-cols-2 gap-2">
          <select
            value={ownerType}
            onChange={(e) => {
              setOwnerType(e.target.value as OwnerType | "");
              setOwnerId("");
            }}
            className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
          >
            <option value="">No owner</option>
            <option value="company">Company</option>
            <option value="person">Person</option>
          </select>
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
            disabled={!ownerType}
          >
            <option value="">{ownerType ? "Select…" : "—"}</option>
            {ownerType === "company" &&
              companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            {ownerType === "person" &&
              people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </div>
      </div>

      {ownerType === "person" && ownerId && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">Joint holders (optional)</div>
          <div className="space-y-1">
            {people.filter(p => p.id !== ownerId).map(p => (
              <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={jointOwnerIds.includes(p.id)}
                  onChange={e => setJointOwnerIds(prev =>
                    e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id)
                  )}
                  className="accent-emerald-500"
                />
                {p.name}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-xs text-zinc-400 mb-1">Type</div>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as AccountType)}
            className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
          >
            <option value="bank">Bank</option>
            <option value="credit">Credit card</option>
            <option value="voucher">Voucher</option>
            <option value="bonds">Bonds / CTT</option>
            <option value="wallet">Wallet</option>
            <option value="cash">Cash</option>
          </select>
        </div>
        <div>
          <div className="text-xs text-zinc-400 mb-1">Currency</div>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as "EUR")}
            className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
          >
            <option value="EUR">EUR</option>
          </select>
        </div>
      </div>

      <div>
        <div className="text-xs text-zinc-400 mb-1">Name</div>
        <Input
          placeholder="e.g., BPI Main / Edenred Meal / AMEX Corp"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>

      {type === "bank" && (
        <div className="space-y-2">
          <div>
            <div className="text-xs text-zinc-400 mb-1">Bank</div>
            <Input
              placeholder="BPI / CGD / Millennium…"
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
            />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">IBAN</div>
            <Input placeholder="PT50…" value={iban} onChange={(e) => setIban(e.target.value)} />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">BIC</div>
            <Input placeholder="BBPIPTPL…" value={bic} onChange={(e) => setBic(e.target.value)} />
          </div>
        </div>
      )}

      {type === "credit" && (
        <div className="space-y-2">
          <div>
            <div className="text-xs text-zinc-400 mb-1">Issuer</div>
            <Input placeholder="AMEX / VISA…" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Last 4</div>
            <Input placeholder="1234" value={last4} onChange={(e) => setLast4(e.target.value)} />
          </div>
        </div>
      )}

      {type === "voucher" && (
        <div className="space-y-2">
          <div>
            <div className="text-xs text-zinc-400 mb-1">Voucher type</div>
            <select
              value={voucherType}
              onChange={(e) => setVoucherType(e.target.value as VoucherType)}
              className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1"
            >
              <option value="meal">Meal</option>
              <option value="childcare">Childcare</option>
              <option value="education">Education</option>
            </select>
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Provider</div>
            <Input
              placeholder="Edenred / Coverflex / …"
              value={voucherProvider}
              onChange={(e) => setVoucherProvider(e.target.value)}
            />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Issuing employer</div>
            <Input
              placeholder="NoisySource / Exquisite Talent / …"
              value={issuingEmployer}
              onChange={(e) => setIssuingEmployer(e.target.value)}
            />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Monthly top-up (€)</div>
            <Input
              type="number"
              placeholder="0.00"
              step="0.01"
              value={monthlyTopUp}
              onChange={(e) => setMonthlyTopUp(e.target.value)}
            />
          </div>
        </div>
      )}

      {type === "bonds" && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">Provider</div>
          <Input
            placeholder="CTT"
            value={bondsProvider}
            onChange={(e) => setBondsProvider(e.target.value)}
          />
        </div>
      )}

      <div>
        <div className="text-xs text-zinc-400 mb-1">Auto code</div>
        <div className="text-sm font-mono bg-zinc-950 border border-zinc-800 rounded px-2 py-1">
          {codePreview || "…"}
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={submitDisabled}>
          {editingId ? "Update" : "Create"}
        </Button>
        {editingId && (
          <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}