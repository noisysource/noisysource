import { useEffect, useMemo, useState } from "react";
import { studyRoomService } from "../../services/studyRoomService";
import { emailService } from "../../services/emailService";
import type { StudyRoomEntry } from "@shared/models/StudyRoomEntry";

type Recipient = {
  id: string;
  email: string;
  studentName: string;
  guardianName: string;
  status?: string;
  schoolName?: string;
};

const VARS = ["studentName", "guardianName", "status", "schoolName"] as const;

// ✅ unified light-field styles (white background)
const fieldCls =
  "w-full border border-neutral-300 rounded px-2 py-1 " +
  "bg-white text-neutral-900 placeholder-neutral-400 " +
  "focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500";

export default function AdminEmailCenter() {
  const [entries, setEntries] = useState<StudyRoomEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // filters
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState("");

  // selection
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  // composer
  const [subjectTpl, setSubjectTpl] = useState("Atualização da inscrição de {{studentName}}");
  const [bodyTpl, setBodyTpl] = useState(
    `Olá {{guardianName}},<br/><br/>
Recebemos a inscrição de {{studentName}} ({{schoolName}}). O estado atual é: <b>{{status}}</b>.<br/><br/>
Obrigado!`
  );
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const list = await studyRoomService.getStudyRoomEntries();
      setEntries(list);
      setLoading(false);
    })();
  }, []);

  const recipients: Recipient[] = useMemo(() => {
    return entries
      .map((e) => ({
        id: e.id,
        email: (e as any).email || "",
        studentName: e.childName,
        guardianName: (e as any).guardianName || "",
        status: e.status || "",
        schoolName: e.schoolName,
      }))
      .filter((r) => r.email && r.email.includes("@"));
  }, [entries]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return recipients.filter((r) => {
      if (statusFilter && (r.status || "") !== statusFilter) return false;
      if (!term) return true;
      return (
        r.studentName.toLowerCase().includes(term) ||
        (r.guardianName || "").toLowerCase().includes(term) ||
        (r.email || "").toLowerCase().includes(term)
      );
    });
  }, [recipients, statusFilter, search]);

  const allSelectableIds = filtered.map((r) => r.id);
  const selectedCount = useMemo(
    () => allSelectableIds.filter((id) => selected[id]).length,
    [allSelectableIds, selected]
  );

  const toggleAll = (checked: boolean) => {
    const next: Record<string, boolean> = {};
    for (const id of allSelectableIds) next[id] = checked;
    setSelected(next);
  };

  async function sendSelected() {
    if (!selectedCount) {
      setMsg("Selecione pelo menos um destinatário.");
      return;
    }
    if (!subjectTpl.trim() || !bodyTpl.trim()) {
      setMsg("Preencha assunto e mensagem.");
      return;
    }
    setSending(true);
    setMsg(null);

    try {
      const toSend = filtered.filter((r) => selected[r.id]);
      const sentCount = await emailService.sendEmails(toSend, subjectTpl, bodyTpl, statusFilter, search);
      setMsg(`Enfileiradas ${sentCount} mensagens. O serviço de envio tratará do resto ✅`);
    } catch (e: any) {
      setMsg(e?.message ?? "Falha ao enfileirar emails.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-xl font-semibold mb-4">Email Center — Sala de Estudo</h1>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <div className="text-xs text-neutral-500 mb-1">Estado</div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className={fieldCls}
          >
            <option value="">Todos</option>
            <option value="pending">Pendente</option>
            <option value="confirmed">Confirmado</option>
            <option value="canceled">Cancelado</option>
          </select>
        </div>
        <div>
          <div className="text-xs text-neutral-500 mb-1">Pesquisar</div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={fieldCls}
            placeholder="Aluno, encarregado, email…"
          />
        </div>
        <div className="ml-auto text-sm text-neutral-600">
          {loading ? "A carregar…" : `${filtered.length} destinatário(s)`}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
        {/* LEFT: recipients table */}
        <div className="rounded border border-neutral-200 overflow-x-auto bg-white">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-neutral-700 bg-neutral-50">
                <th className="px-3 py-2 w-10">
                  <input
                    type="checkbox"
                    onChange={(e) => toggleAll(e.target.checked)}
                    checked={filtered.length > 0 && filtered.every((r) => selected[r.id])}
                  />
                </th>
                <th className="px-3 py-2">Aluno</th>
                <th className="px-3 py-2">Encarregado</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Escola</th>
                <th className="px-3 py-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-neutral-200">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={!!selected[r.id]}
                      onChange={(e) =>
                        setSelected((s) => ({ ...s, [r.id]: e.target.checked }))
                      }
                    />
                  </td>
                  <td className="px-3 py-2">{r.studentName}</td>
                  <td className="px-3 py-2">{r.guardianName}</td>
                  <td className="px-3 py-2">{r.email}</td>
                  <td className="px-3 py-2">{r.schoolName || "—"}</td>
                  <td className="px-3 py-2 capitalize">{r.status || "—"}</td>
                </tr>
              ))}
              {!filtered.length && !loading && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-neutral-500">
                    Sem resultados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* RIGHT: composer */}
        <div className="rounded border border-neutral-200 p-3 space-y-3 bg-white">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-neutral-800">Compositor</div>
            <div className="text-xs text-neutral-500">
              Selecionados: <b>{selectedCount}</b>
            </div>
          </div>

          <div>
            <div className="text-xs text-neutral-600 mb-1">Assunto</div>
            <input
              value={subjectTpl}
              onChange={(e) => setSubjectTpl(e.target.value)}
              className={fieldCls}
            />
          </div>

          <div>
            <div className="text-xs text-neutral-600 mb-1">
              Mensagem (suporta HTML). Variáveis:{" "}
              <code className="text-[11px]">
                {VARS.map((v) => `{{${v}}}`).join(", ")}
              </code>
            </div>
            <textarea
              value={bodyTpl}
              onChange={(e) => setBodyTpl(e.target.value)}
              rows={10}
              className={`${fieldCls} font-mono text-xs`}
            />
          </div>

          <button
            className="px-3 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-60"
            disabled={sending || selectedCount === 0}
            onClick={sendSelected}
          >
            {sending ? "A enviar…" : "Enviar para selecionados"}
          </button>

          {msg && <div className="text-xs text-emerald-600">{msg}</div>}
        </div>
      </div>
    </div>
  );
}