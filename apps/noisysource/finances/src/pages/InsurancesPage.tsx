import { useEffect, useMemo, useRef, useState } from "react";
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from "firebase/storage";
import { storage } from "../lib/firebase";
import type { InsuranceDoc, InsuranceType, InsuranceFrequency, InsuranceAttachment } from "@shared/models/Insurance";
import { formatEUR } from "@shared/lib/money";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { api } from "../lib/api";
import { useEntity } from "../hooks/EntityContext";
import {
  Plus, Pencil, Trash2, Paperclip, Download, X,
  Heart, Car, Home, Briefcase, Plane, Shield, HardHat, HelpCircle,
  Upload, AlertTriangle,
} from "lucide-react";

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<InsuranceType, string> = {
  health: "Saúde",
  life: "Vida",
  car: "Automóvel",
  home: "Habitação",
  liability: "Responsabilidade Civil",
  work: "Acidentes de Trabalho",
  travel: "Viagem",
  other: "Outro",
};

const TYPE_ICON: Record<InsuranceType, React.ReactNode> = {
  health:    <Heart   size={15} className="text-red-400" />,
  life:      <Shield  size={15} className="text-emerald-400" />,
  car:       <Car     size={15} className="text-blue-400" />,
  home:      <Home    size={15} className="text-amber-400" />,
  liability: <Briefcase size={15} className="text-purple-400" />,
  work:      <HardHat size={15} className="text-orange-400" />,
  travel:    <Plane   size={15} className="text-cyan-400" />,
  other:     <HelpCircle size={15} className="text-zinc-400" />,
};

const FREQ_LABEL: Record<InsuranceFrequency, string> = {
  monthly: "mês",
  quarterly: "trim.",
  annual: "ano",
};

const FREQ_MONTHS: Record<InsuranceFrequency, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

const TYPE_ORDER: InsuranceType[] = ["health", "life", "car", "home", "liability", "work", "travel", "other"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function monthlyEquivalentCents(ins: InsuranceDoc): number {
  return Math.round(ins.premiumCents / FREQ_MONTHS[ins.frequency]);
}

function daysUntil(dateStr: string): number {
  const d = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((d.getTime() - now.getTime()) / 86400000);
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ── Form state ────────────────────────────────────────────────────────────────

interface FormState {
  id?: string;
  name: string;
  type: InsuranceType;
  insurer: string;
  policyNumber: string;
  premiumCents: string;
  frequency: InsuranceFrequency;
  startDate: string;
  renewalDate: string;
  insuredPersons: string;
  notes: string;
  active: boolean;
}

function emptyForm(): FormState {
  return {
    name: "", type: "health", insurer: "",
    policyNumber: "", premiumCents: "",
    frequency: "annual",
    startDate: "", renewalDate: "",
    insuredPersons: "", notes: "", active: true,
  };
}

function fromDoc(d: InsuranceDoc): FormState {
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    insurer: d.insurer,
    policyNumber: d.policyNumber ?? "",
    premiumCents: d.premiumCents ? String(d.premiumCents / 100) : "",
    frequency: d.frequency,
    startDate: d.startDate ?? "",
    renewalDate: d.renewalDate ?? "",
    insuredPersons: d.insuredPersons ?? "",
    notes: d.notes ?? "",
    active: d.active,
  };
}

// ── Insurance modal ───────────────────────────────────────────────────────────

function InsuranceModal({
  editing, entityId, onSaved, onClose,
}: {
  editing: InsuranceDoc | null;
  entityId: string;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>(editing ? fromDoc(editing) : emptyForm());
  const [saving, setSaving] = useState(false);

  const set = (k: keyof FormState, v: any) => setForm(f => ({ ...f, [k]: v }));

  const TYPES: InsuranceType[] = ["health", "life", "car", "home", "liability", "work", "travel", "other"];
  const FREQS: InsuranceFrequency[] = ["monthly", "quarterly", "annual"];

  async function handleSave() {
    if (!form.name.trim() || !form.insurer.trim()) return;
    setSaving(true);
    try {
      const premiumCents = Math.round(parseFloat(form.premiumCents.replace(",", ".")) * 100) || 0;
      const savedId = await api.insurances.save({
        id: form.id,
        name: form.name.trim(),
        type: form.type,
        insurer: form.insurer.trim(),
        policyNumber: form.policyNumber.trim() || undefined,
        premiumCents,
        frequency: form.frequency,
        startDate: form.startDate || undefined,
        renewalDate: form.renewalDate || undefined,
        insuredPersons: form.insuredPersons.trim() || undefined,
        notes: form.notes.trim() || undefined,
        attachments: editing?.attachments ?? [],
        active: form.active,
      } as any);

      // Auto-link to recurring expenses
      const sourceId = `insurance:${savedId}`;
      if (form.active && premiumCents > 0) {
        const renewalDate = form.renewalDate ? new Date(`${form.renewalDate}T00:00:00`) : null;
        const dayOfMonth = renewalDate ? renewalDate.getDate() : 1;
        const monthOfYear = renewalDate && form.frequency === "annual" ? renewalDate.getMonth() + 1 : undefined;
        await api.recurring.upsertBySourceId(sourceId, {
          type: "expense",
          description: `${form.name.trim()} (${form.insurer.trim()})`,
          amountCents: premiumCents,
          vatCode: "isento", // insurance premiums are VAT-exempt (CIVA art. 9)
          frequency: form.frequency,
          dayOfMonth,
          monthOfYear,
          active: true,
          sourceId,
        });
      } else if (!form.active) {
        await api.recurring.deactivateBySourceId(sourceId);
      }

      await onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="w-full max-w-md p-5 overflow-y-auto max-h-[90vh] space-y-4">
        <div className="text-base font-semibold">{editing ? "Editar seguro" : "Novo seguro"}</div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Nome *</label>
            <input
              className="w-full bg-zinc-800 rounded px-3 py-2 text-sm"
              placeholder="ex. Saúde Médis - Renato"
              value={form.name}
              onChange={e => set("name", e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Tipo *</label>
              <select
                className="w-full bg-zinc-800 rounded px-3 py-2 text-sm"
                value={form.type}
                onChange={e => set("type", e.target.value as InsuranceType)}
              >
                {TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Seguradora *</label>
              <input
                className="w-full bg-zinc-800 rounded px-3 py-2 text-sm"
                placeholder="ex. Fidelidade"
                value={form.insurer}
                onChange={e => set("insurer", e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Apólice nº</label>
            <input
              className="w-full bg-zinc-800 rounded px-3 py-2 text-sm font-mono"
              placeholder="ex. 1234567890"
              value={form.policyNumber}
              onChange={e => set("policyNumber", e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Prémio (€)</label>
              <input
                className="w-full bg-zinc-800 rounded px-3 py-2 text-sm"
                placeholder="0,00"
                value={form.premiumCents}
                onChange={e => set("premiumCents", e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Periodicidade</label>
              <select
                className="w-full bg-zinc-800 rounded px-3 py-2 text-sm"
                value={form.frequency}
                onChange={e => set("frequency", e.target.value as InsuranceFrequency)}
              >
                {FREQS.map(f => (
                  <option key={f} value={f}>
                    {{ monthly: "Mensal", quarterly: "Trimestral", annual: "Anual" }[f]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Início</label>
              <input
                type="date"
                className="w-full bg-zinc-800 rounded px-3 py-2 text-sm"
                value={form.startDate}
                onChange={e => set("startDate", e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Renovação</label>
              <input
                type="date"
                className="w-full bg-zinc-800 rounded px-3 py-2 text-sm"
                value={form.renewalDate}
                onChange={e => set("renewalDate", e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Segurados</label>
            <input
              className="w-full bg-zinc-800 rounded px-3 py-2 text-sm"
              placeholder="ex. Renato, Marisa"
              value={form.insuredPersons}
              onChange={e => set("insuredPersons", e.target.value)}
            />
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Notas</label>
            <textarea
              rows={2}
              className="w-full bg-zinc-800 rounded px-3 py-2 text-sm resize-none"
              value={form.notes}
              onChange={e => set("notes", e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={form.active}
              onChange={e => set("active", e.target.checked)}
            />
            Ativo
          </label>
        </div>

        <div className="flex gap-2 pt-1">
          <Button onClick={handleSave} disabled={saving || !form.name.trim() || !form.insurer.trim()}>
            {saving ? "A guardar…" : "Guardar"}
          </Button>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
        </div>
      </Card>
    </div>
  );
}

// ── Attachment upload ─────────────────────────────────────────────────────────

function AttachmentRow({
  attachment, onDelete,
}: {
  attachment: InsuranceAttachment;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-400 group">
      <Paperclip size={11} className="shrink-0 text-zinc-600" />
      <a
        href={attachment.downloadUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-1 truncate hover:text-zinc-100 hover:underline"
        title={attachment.name}
      >
        {attachment.name}
      </a>
      {attachment.sizeBytes != null && (
        <span className="text-zinc-600 shrink-0">{formatBytes(attachment.sizeBytes)}</span>
      )}
      <a
        href={attachment.downloadUrl}
        download={attachment.name}
        className="p-0.5 rounded hover:text-zinc-100 hover:bg-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <Download size={11} />
      </a>
      <button
        onClick={onDelete}
        className="p-0.5 rounded hover:text-red-400 hover:bg-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X size={11} />
      </button>
    </div>
  );
}

interface FileUploadState {
  name: string;
  progress: number;
  error?: string;
}

function UploadZone({
  insuranceId, entityId, onUploaded,
}: {
  insuranceId: string;
  entityId: string;
  onUploaded: (attachment: InsuranceAttachment) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<FileUploadState[]>([]);

  function setFileState(name: string, patch: Partial<FileUploadState>) {
    setUploads(prev => prev.map(u => u.name === name ? { ...u, ...patch } : u));
  }

  async function uploadOne(file: File) {
    const attachmentId = crypto.randomUUID();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `finances/${entityId}/insurances/${insuranceId}/${attachmentId}_${safeName}`;
    const storageRef = ref(storage, storagePath);
    const task = uploadBytesResumable(storageRef, file);

    return new Promise<void>((resolve) => {
      task.on(
        "state_changed",
        snap => setFileState(file.name, { progress: Math.round((snap.bytesTransferred / snap.totalBytes) * 100) }),
        err => { setFileState(file.name, { error: err.message }); resolve(); },
        async () => {
          const downloadUrl = await getDownloadURL(storageRef);
          const attachment: InsuranceAttachment = {
            id: attachmentId,
            name: file.name,
            storagePath,
            downloadUrl,
            contentType: file.type || undefined,
            sizeBytes: file.size,
            uploadedAt: new Date().toISOString().slice(0, 10),
          };
          await api.insurances.addAttachment(insuranceId, attachment);
          onUploaded(attachment);
          setUploads(prev => prev.filter(u => u.name !== file.name));
          resolve();
        }
      );
    });
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setUploads(prev => [...prev, ...list.map(f => ({ name: f.name, progress: 0 }))]);
    await Promise.all(list.map(uploadOne));
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="mt-2 space-y-1">
      {uploads.map(u => (
        <div key={u.name} className="space-y-0.5">
          {u.error ? (
            <div className="flex items-center gap-1 text-xs text-red-400">
              <AlertTriangle size={11} /> {u.name}: {u.error}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="truncate flex-1 max-w-[180px]">{u.name}</span>
              <div className="w-16 bg-zinc-700 rounded-full h-1">
                <div className="bg-blue-500 h-1 rounded-full transition-all" style={{ width: `${u.progress}%` }} />
              </div>
              <span className="shrink-0">{u.progress}%</span>
            </div>
          )}
        </div>
      ))}
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={e => handleFiles(e.target.files)}
      />
      <button
        onClick={() => fileRef.current?.click()}
        className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 px-2 py-1 rounded transition-colors"
      >
        <Upload size={11} /> Carregar documentos
      </button>
    </div>
  );
}

// ── Insurance card ────────────────────────────────────────────────────────────

function InsuranceCard({
  ins, entityId, onEdit, onDelete, onAttachmentAdded, onAttachmentRemoved,
}: {
  ins: InsuranceDoc;
  entityId: string;
  onEdit: () => void;
  onDelete: () => void;
  onAttachmentAdded: (a: InsuranceAttachment) => void;
  onAttachmentRemoved: (id: string) => void;
}) {
  const [showAttachments, setShowAttachments] = useState(false);

  const renewalDays = ins.renewalDate ? daysUntil(ins.renewalDate) : null;
  const renewalUrgent = renewalDays != null && renewalDays <= 60;
  const renewalColor = renewalDays == null
    ? ""
    : renewalDays <= 14 ? "text-red-400"
    : renewalDays <= 60 ? "text-amber-400"
    : "text-zinc-500";

  async function deleteAttachment(attachment: InsuranceAttachment) {
    if (!confirm(`Eliminar "${attachment.name}"?`)) return;
    try {
      await deleteObject(ref(storage, attachment.storagePath));
    } catch {
      // File may not exist in storage — continue with Firestore update
    }
    await api.insurances.removeAttachment(ins.id, attachment.id);
    onAttachmentRemoved(attachment.id);
  }

  return (
    <Card className={`px-4 py-3 ${!ins.active ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-3">
        <div className="pt-0.5 shrink-0">{TYPE_ICON[ins.type]}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm text-zinc-100">{ins.name}</span>
            {!ins.active && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">inativo</span>
            )}
            {renewalUrgent && renewalDays != null && (
              <span className={`text-xs font-medium ${renewalColor}`}>
                {renewalDays <= 0 ? "Expirado" : `Renova em ${renewalDays}d`}
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {ins.insurer}
            {ins.policyNumber && <span className="ml-2 font-mono text-zinc-600">#{ins.policyNumber}</span>}
          </div>
          {ins.insuredPersons && (
            <div className="text-xs text-zinc-600 mt-0.5">{ins.insuredPersons}</div>
          )}
          {ins.renewalDate && (
            <div className={`text-xs mt-0.5 ${renewalColor || "text-zinc-500"}`}>
              Renovação: {ins.renewalDate}
            </div>
          )}
          {ins.notes && (
            <div className="text-xs text-zinc-600 mt-1 italic">{ins.notes}</div>
          )}

          {/* Attachments */}
          <div className="mt-2">
            {ins.attachments.length > 0 && (
              <button
                onClick={() => setShowAttachments(v => !v)}
                className="text-xs text-zinc-500 hover:text-zinc-200 flex items-center gap-1 mb-1"
              >
                <Paperclip size={11} />
                {ins.attachments.length} documento{ins.attachments.length !== 1 ? "s" : ""}
                <span className="text-zinc-700">{showAttachments ? "▾" : "▸"}</span>
              </button>
            )}
            {(showAttachments || ins.attachments.length === 0) && (
              <div className="space-y-1">
                {ins.attachments.map(a => (
                  <AttachmentRow
                    key={a.id}
                    attachment={a}
                    onDelete={() => deleteAttachment(a)}
                  />
                ))}
              </div>
            )}
            <UploadZone
              insuranceId={ins.id}
              entityId={entityId}
              onUploaded={attachment => { onAttachmentAdded(attachment); setShowAttachments(true); }}
            />
          </div>
        </div>

        <div className="flex items-center gap-4 shrink-0 ml-2">
          <div className="text-right">
            <div className="font-mono font-semibold text-sm text-zinc-100">
              {formatEUR(ins.premiumCents)}
              <span className="text-xs text-zinc-500 font-normal ml-1">/{FREQ_LABEL[ins.frequency]}</span>
            </div>
            <div className="text-xs text-zinc-600">{formatEUR(monthlyEquivalentCents(ins))}/mês</div>
          </div>
          <div className="flex gap-1">
            <button onClick={onEdit}
              className="p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
              <Pencil size={13} />
            </button>
            <button onClick={onDelete}
              className="p-1.5 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors">
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InsurancesPage() {
  const { selectedEntity } = useEntity();
  const [insurances, setInsurances] = useState<InsuranceDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingIns, setEditingIns] = useState<InsuranceDoc | null>(null);

  async function reload() {
    setLoading(true);
    try {
      setInsurances(await api.insurances.list() as InsuranceDoc[]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); }, [selectedEntity.id]);

  async function deleteOne(ins: InsuranceDoc) {
    if (!confirm(`Eliminar "${ins.name}"? As apólices em Firebase Storage não serão eliminadas automaticamente.`)) return;
    await api.insurances.delete(ins.id);
    await reload();
  }

  function openNew() { setEditingIns(null); setModalOpen(true); }
  function openEdit(ins: InsuranceDoc) { setEditingIns(ins); setModalOpen(true); }

  function patchAttachment(insuranceId: string, updater: (prev: InsuranceAttachment[]) => InsuranceAttachment[]) {
    setInsurances(prev => prev.map(ins =>
      ins.id === insuranceId ? { ...ins, attachments: updater(ins.attachments) } : ins
    ));
  }

  // Group by type
  const grouped = useMemo(() => {
    const map = new Map<InsuranceType, InsuranceDoc[]>();
    for (const ins of insurances) {
      if (!map.has(ins.type)) map.set(ins.type, []);
      map.get(ins.type)!.push(ins);
    }
    return TYPE_ORDER.filter(t => map.has(t)).map(t => ({ type: t, items: map.get(t)! }));
  }, [insurances]);

  const totalMonthlyCents = useMemo(() =>
    insurances.filter(i => i.active).reduce((s, i) => s + monthlyEquivalentCents(i), 0),
    [insurances]);

  const totalAnnualCents = useMemo(() => totalMonthlyCents * 12, [totalMonthlyCents]);

  const renewingSoon = useMemo(() =>
    insurances.filter(i => i.active && i.renewalDate && daysUntil(i.renewalDate) <= 60 && daysUntil(i.renewalDate) >= 0)
      .sort((a, b) => a.renewalDate!.localeCompare(b.renewalDate!)),
    [insurances]);

  if (loading) return <div className="text-zinc-500 text-sm p-4">A carregar…</div>;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Seguros</h1>
          <p className="text-xs text-zinc-500 mt-0.5">{selectedEntity.name}</p>
        </div>
        <Button onClick={openNew}>
          <Plus size={14} className="mr-1" /> Novo seguro
        </Button>
      </div>

      {/* Summary */}
      {insurances.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <Card className="p-3">
            <div className="text-xs text-zinc-400 mb-1">Custo mensal estimado</div>
            <div className="text-lg font-bold text-zinc-100">{formatEUR(totalMonthlyCents)}</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-zinc-400 mb-1">Custo anual estimado</div>
            <div className="text-lg font-bold text-zinc-100">{formatEUR(totalAnnualCents)}</div>
          </Card>
        </div>
      )}

      {/* Renewals alert */}
      {renewingSoon.length > 0 && (
        <Card className="p-3 border border-amber-800/40 bg-amber-950/20">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-400 mb-2">
            <AlertTriangle size={13} /> Renovações nos próximos 60 dias
          </div>
          <div className="space-y-1">
            {renewingSoon.map(ins => {
              const days = daysUntil(ins.renewalDate!);
              return (
                <div key={ins.id} className="flex items-center justify-between text-xs">
                  <span className="text-zinc-300">{ins.name}</span>
                  <span className={days <= 14 ? "text-red-400 font-medium" : "text-amber-400"}>
                    {ins.renewalDate} ({days}d)
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Groups */}
      {grouped.length === 0 && (
        <div className="text-center py-12 text-zinc-600">
          <div className="text-4xl mb-3">🛡️</div>
          <div>Sem seguros registados.</div>
          <div className="text-sm mt-1">Clica em "Novo seguro" para começar.</div>
        </div>
      )}

      {grouped.map(({ type, items }) => (
        <div key={type}>
          <div className="flex items-center gap-2 mb-2">
            {TYPE_ICON[type]}
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              {TYPE_LABEL[type]}
            </span>
          </div>
          <div className="space-y-2">
            {items.map(ins => (
              <InsuranceCard
                key={ins.id}
                ins={ins}
                entityId={selectedEntity.id}
                onEdit={() => openEdit(ins)}
                onDelete={() => deleteOne(ins)}
                onAttachmentAdded={a => patchAttachment(ins.id, prev => [...prev, a])}
                onAttachmentRemoved={id => patchAttachment(ins.id, prev => prev.filter(x => x.id !== id))}
              />
            ))}
          </div>
        </div>
      ))}

      {modalOpen && (
        <InsuranceModal
          editing={editingIns}
          entityId={selectedEntity.id}
          onSaved={reload}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
