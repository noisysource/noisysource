import { useEffect, useMemo, useState } from "react";
import type { Account, AccountType, VoucherType } from "@shared/models/Account";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { api } from "../../lib/api";

const slug = (s: string) =>
  (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function AccountForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: Account | null;
  onSaved?: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [type, setType] = useState<AccountType>("bank");
  const [name, setName] = useState("");
  const [balanceCents, setBalanceCents] = useState("");
  const [balanceAsOf, setBalanceAsOf] = useState("");

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

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!initial) {
      setEditingId(null);
      setType("bank");
      setName("");
      setBalanceCents(""); setBalanceAsOf("");
      setBankName(""); setIban(""); setBic("");
      setIssuer(""); setLast4("");
      setVoucherType("meal"); setVoucherProvider("Edenred"); setIssuingEmployer(""); setMonthlyTopUp("");
      setBondsProvider("CTT");
      return;
    }
    setEditingId(initial.id);
    setType(initial.type);
    setName(initial.name || "");
    setBalanceCents(initial.balanceCents != null ? String(initial.balanceCents / 100) : "");
    setBalanceAsOf((initial as any).balanceAsOf || "");
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

  const codePreview = useMemo(() => {
    return [type, slug(name || type)].join(":");
  }, [type, name]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setErr(null);
    try {
      const bal = balanceCents !== "" ? Math.round(parseFloat(balanceCents) * 100) : undefined;
      const topUp = monthlyTopUp ? Math.round(parseFloat(monthlyTopUp) * 100) : undefined;

      const base = {
        id: editingId || undefined,
        code: codePreview,
        name: name.trim(),
        type,
        currency: "EUR" as const,
        balanceCents: bal,
        balanceAsOf: balanceAsOf || undefined,
      };

      const payload =
        type === "bank"
          ? { ...base, bankName: bankName || undefined, iban: iban || undefined, bic: bic || undefined }
          : type === "credit"
          ? { ...base, issuer: issuer || undefined, last4: last4 || undefined }
          : type === "voucher"
          ? { ...base, voucherType, provider: voucherProvider || undefined, issuingEmployer: issuingEmployer || undefined, monthlyTopUpCents: topUp }
          : type === "bonds"
          ? { ...base, provider: bondsProvider || undefined }
          : base;

      await api.accounts.save(payload as any);
      await onSaved?.();
    } catch (e: any) {
      setErr(e?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-3">
      {err && <div className="text-sm text-red-400">{err}</div>}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-xs text-zinc-400 mb-1">Tipo</div>
          <select value={type} onChange={e => setType(e.target.value as AccountType)}
            className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1">
            <option value="bank">Conta bancária</option>
            <option value="credit">Cartão crédito</option>
            <option value="voucher">Voucher</option>
            <option value="bonds">Obrigações / CTT</option>
            <option value="wallet">Wallet</option>
            <option value="cash">Dinheiro</option>
          </select>
        </div>
        <div>
          <div className="text-xs text-zinc-400 mb-1">Moeda</div>
          <div className="bg-zinc-900 border border-zinc-700 text-zinc-400 rounded px-2 py-1 text-sm">EUR</div>
        </div>
      </div>

      <div>
        <div className="text-xs text-zinc-400 mb-1">Nome</div>
        <Input placeholder="ex. BPI Principal / Edenred Refeição" value={name} onChange={e => setName(e.target.value)} required />
      </div>

      {type === "bank" && (
        <div className="space-y-2">
          <div>
            <div className="text-xs text-zinc-400 mb-1">Banco</div>
            <Input placeholder="BPI / CGD / Millennium…" value={bankName} onChange={e => setBankName(e.target.value)} />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">IBAN</div>
            <Input placeholder="PT50…" value={iban} onChange={e => setIban(e.target.value)} />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">BIC</div>
            <Input placeholder="BBPIPTPL…" value={bic} onChange={e => setBic(e.target.value)} />
          </div>
        </div>
      )}

      {type === "credit" && (
        <div className="space-y-2">
          <div>
            <div className="text-xs text-zinc-400 mb-1">Emissor</div>
            <Input placeholder="AMEX / VISA…" value={issuer} onChange={e => setIssuer(e.target.value)} />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Últimos 4 dígitos</div>
            <Input placeholder="1234" value={last4} onChange={e => setLast4(e.target.value)} />
          </div>
        </div>
      )}

      {type === "voucher" && (
        <div className="space-y-2">
          <div>
            <div className="text-xs text-zinc-400 mb-1">Tipo de voucher</div>
            <select value={voucherType} onChange={e => setVoucherType(e.target.value as VoucherType)}
              className="w-full bg-zinc-900 border border-zinc-700 text-white rounded px-2 py-1">
              <option value="meal">Refeição</option>
              <option value="childcare">Creche</option>
              <option value="education">Educação</option>
            </select>
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Fornecedor</div>
            <Input placeholder="Edenred / Coverflex…" value={voucherProvider} onChange={e => setVoucherProvider(e.target.value)} />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Entidade emissora</div>
            <Input placeholder="NoisySource / Exquisite Talent…" value={issuingEmployer} onChange={e => setIssuingEmployer(e.target.value)} />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Carregamento mensal (€)</div>
            <Input type="number" placeholder="0.00" step="0.01" value={monthlyTopUp} onChange={e => setMonthlyTopUp(e.target.value)} />
          </div>
        </div>
      )}

      {type === "bonds" && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">Fornecedor</div>
          <Input placeholder="CTT" value={bondsProvider} onChange={e => setBondsProvider(e.target.value)} />
        </div>
      )}

      <div className="border-t border-zinc-800 pt-3 space-y-2">
        <div className="text-xs text-zinc-400 font-semibold uppercase tracking-wide">Saldo atual (opcional)</div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="text-xs text-zinc-400 mb-1">Saldo (€)</div>
            <Input type="number" placeholder="0.00" step="0.01" value={balanceCents} onChange={e => setBalanceCents(e.target.value)} />
          </div>
          <div>
            <div className="text-xs text-zinc-400 mb-1">Data</div>
            <Input type="date" value={balanceAsOf} onChange={e => setBalanceAsOf(e.target.value)} />
          </div>
        </div>
      </div>

      <div>
        <div className="text-xs text-zinc-400 mb-1">Código automático</div>
        <div className="text-sm font-mono bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-300">
          {codePreview}
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={busy || !name.trim()}>
          {editingId ? "Atualizar" : "Criar"}
        </Button>
        {editingId && (
          <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}
