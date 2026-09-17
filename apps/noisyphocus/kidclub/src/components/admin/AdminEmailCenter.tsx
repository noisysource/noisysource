import { useEffect, useMemo, useState } from "react";
import { getDocs, query, where, getDoc } from "firebase/firestore";
import { studyRoomService } from "../../services/studyRoomService";
import { emailService } from "../../services/emailService";
import { col, docRef } from "../../lib/db";
import type { StudyRoomEntry } from "@shared/models/StudyRoomEntry";
import type { TransportationSubscription } from "@shared/models/Transportation";
import type { Family } from "@shared/models";
import { normalizeSubStatus } from "../../lib/utils";

type Audience = "studyroom" | "transport" | "all";

type Recipient = {
  id: string;
  email: string;
  audience: Audience;
  // study room
  studentName?: string;
  guardianName?: string;
  status?: string;
  schoolName?: string;
  // transport
  nomes?: string;
  escola?: string;
  mensalidade?: string;
  dias?: string;
};

const DAY_PT: Record<string, string> = {
  monday: "Segunda", tuesday: "Terça", wednesday: "Quarta",
  thursday: "Quinta", friday: "Sexta", saturday: "Sábado", sunday: "Domingo",
};

const DEFAULT_TEMPLATES: Record<Audience, { subject: string; body: string }> = {
  studyroom: {
    subject: "Atualização da inscrição de {{studentName}}",
    body: `Olá {{guardianName}},<br/><br/>Recebemos a inscrição de {{studentName}} ({{schoolName}}). O estado atual é: <b>{{status}}</b>.<br/><br/>Obrigado!`,
  },
  transport: {
    subject: "Informação sobre o transporte escolar — {{nomes}}",
    body: `Olá,<br/><br/>Confirmamos o transporte escolar para <b>{{nomes}}</b> ({{escola}}).<br/>Dias: {{dias}}<br/>Mensalidade: <b>{{mensalidade}}</b><br/><br/>Qualquer questão, não hesite em contactar-nos.<br/><br/>Obrigado!`,
  },
  all: {
    subject: "Bem-vindo ao KidClub — o seu portal de família está pronto",
    body: `Olá,<br/><br/>É com muito gosto que damos as boas-vindas à sua família ao <b>KidClub — Arco-Íris da Pequenada</b>! 🌈<br/><br/>Criámos um portal dedicado onde pode acompanhar tudo o que diz respeito às inscrições dos seus filhos — mensalidades, descontos, faturas e muito mais.<br/><br/><div style="text-align:center;margin:24px 0;"><a href="https://kidclub.pt" style="display:inline-block;background:#16a34a;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">Aceder ao portal →</a></div>Para entrar, basta usar o email <b>{{email}}</b>. Pode fazê-lo de duas formas:<br/><br/>→ <b>Com Google</b> — se este é o seu email Google, clique em "Entrar com Google"<br/>→ <b>Por link de acesso</b> — clique em "Entrar com email", introduza o seu endereço e receberá um link direto na caixa de entrada, sem necessidade de palavra-passe<br/><br/>Uma vez dentro, encontrará as suas inscrições à espera de confirmação. Basta revê-las e confirmar — assim que o fizer, estamos prontos a começar!<br/><br/>Se tiver alguma dúvida ou precisar de ajuda, pode contactar-nos através de:<br/>📞 <b>925 581 565</b> — Arco-Íris<br/>📞 <b>912 517 488</b> — Renato Lopes<br/><br/>Com os melhores cumprimentos,<br/><b>Equipa KidClub</b><br/><i>Arco-Íris da Pequenada · Avenida da Guarda Inglesa, Lote E, Coimbra</i>`,
  },
};

const AUDIENCE_VARS: Record<Audience, string[]> = {
  studyroom: ["studentName", "guardianName", "status", "schoolName"],
  transport: ["nomes", "escola", "mensalidade", "dias"],
  all: ["email", "studentName", "guardianName", "status", "schoolName", "nomes", "escola", "mensalidade", "dias"],
};

function applyTokens(tpl: string, r: Record<string, string | undefined>) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = r[k];
    return v == null ? "" : v;
  });
}

const fieldCls =
  "w-full border border-neutral-300 rounded px-2 py-1 " +
  "bg-white text-neutral-900 placeholder-neutral-400 " +
  "focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500";

export default function AdminEmailCenter() {
  const [audience, setAudience] = useState<Audience>("studyroom");
  const [studyEntries, setStudyEntries] = useState<StudyRoomEntry[]>([]);
  const [transportSubs, setTransportSubs] = useState<TransportationSubscription[]>([]);
  const [familyMap, setFamilyMap] = useState<Map<string, Family>>(new Map());
  const [loading, setLoading] = useState(true);

  // filters
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [search, setSearch] = useState("");

  // selection
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  // composer
  const [subjectTpl, setSubjectTpl] = useState(DEFAULT_TEMPLATES.studyroom.subject);
  const [bodyTpl, setBodyTpl] = useState(DEFAULT_TEMPLATES.studyroom.body);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const needsStudy = audience === "studyroom" || audience === "all";
      const needsTransport = audience === "transport" || audience === "all";
      const [study, transport] = await Promise.all([
        needsStudy ? studyRoomService.getStudyRoomEntries() : Promise.resolve(studyEntries),
        needsTransport
          ? getDocs(col("transportationSubscriptions")).then(
              (snap) => snap.docs
                .map((d) => ({ id: d.id, ...d.data(), status: normalizeSubStatus(d.data().status) } as TransportationSubscription))
                .filter((s) => s.status !== "cancelled" && (s.contactEmail?.includes("@")))
            )
          : Promise.resolve(transportSubs),
      ]);

      // For study room entries, batch-fetch families to get the contact email
      if (needsStudy && study.length > 0) {
        const familyIds = [...new Set(study.map((e) => e.familyId).filter(Boolean))];
        const fetched = await Promise.all(
          familyIds.map((fid) => getDoc(docRef("families", fid)).then((s) => s.exists() ? ({ id: fid, ...s.data() } as Family) : null))
        );
        const map = new Map<string, Family>();
        for (const f of fetched) if (f) map.set(f.id, f);
        setFamilyMap(map);
      }

      if (needsStudy) setStudyEntries(study);
      if (needsTransport) setTransportSubs(transport);
      setLoading(false);
    })();
    // Reset template when switching audience
    setSubjectTpl(DEFAULT_TEMPLATES[audience].subject);
    setBodyTpl(DEFAULT_TEMPLATES[audience].body);
    setSelected({});
    setMsg(null);
  }, [audience]); // eslint-disable-line react-hooks/exhaustive-deps

  const studyRecipients: Recipient[] = useMemo(
    () =>
      studyEntries
        .map((e) => {
          const family = familyMap.get(e.familyId);
          const email = family?.primaryContact?.email || (e as any).email || "";
          const guardianName = family?.primaryContact?.name || (e as any).guardianName || "";
          return {
            id: e.id,
            email,
            audience: "studyroom" as Audience,
            studentName: e.childName,
            guardianName,
            status: e.status || "",
            schoolName: e.schoolName,
          };
        })
        .filter((r) => r.email.includes("@")),
    [studyEntries, familyMap]
  );

  const transportRecipients: Recipient[] = useMemo(() => {
    const byEmail = new Map<string, TransportationSubscription[]>();
    for (const sub of transportSubs) {
      if (!sub.contactEmail?.includes("@")) continue;
      const key = sub.contactEmail.toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, []);
      byEmail.get(key)!.push(sub);
    }
    return Array.from(byEmail.entries()).map(([email, subs]) => {
      const names = [...new Set(subs.map((s) => s.childName))];
      const schools = [...new Set(subs.map((s) => s.schoolName).filter(Boolean))];
      const totalFee = subs.reduce((sum, s) => sum + (s.monthlyFee || 0), 0);
      const allDays = [...new Set(subs.flatMap((s) => (s.schedule || []).map((sc) => DAY_PT[sc.dayOfWeek] || sc.dayOfWeek)))];
      return {
        id: `transport:${email}`,
        email: subs[0].contactEmail,
        audience: "transport" as Audience,
        nomes: names.join(", "),
        escola: schools.join(", "),
        mensalidade: `€${totalFee.toFixed(2)}`,
        dias: allDays.join(", "),
      };
    });
  }, [transportSubs]);

  const allRecipients: Recipient[] = useMemo(() => {
    if (audience === "studyroom") return studyRecipients;
    if (audience === "transport") return transportRecipients;
    // merge by email — transport entry wins for transport fields, study entry for study fields
    const byEmail = new Map<string, Recipient>();
    for (const r of studyRecipients) {
      byEmail.set(r.email.toLowerCase(), { ...r, audience: "all" });
    }
    for (const r of transportRecipients) {
      const existing = byEmail.get(r.email.toLowerCase());
      if (existing) {
        byEmail.set(r.email.toLowerCase(), { ...existing, ...r, audience: "all", id: existing.id });
      } else {
        byEmail.set(r.email.toLowerCase(), { ...r, audience: "all" });
      }
    }
    return Array.from(byEmail.values());
  }, [audience, studyRecipients, transportRecipients]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allRecipients.filter((r) => {
      if (statusFilter && audience !== "transport" && (r.status || "") !== statusFilter) return false;
      if (!term) return true;
      return (
        (r.studentName || "").toLowerCase().includes(term) ||
        (r.nomes || "").toLowerCase().includes(term) ||
        (r.guardianName || "").toLowerCase().includes(term) ||
        (r.email || "").toLowerCase().includes(term) ||
        (r.escola || r.schoolName || "").toLowerCase().includes(term)
      );
    });
  }, [allRecipients, statusFilter, search, audience]);

  const allSelectableIds = filtered.map((r) => r.id);
  const selectedCount = useMemo(
    () => allSelectableIds.filter((id) => selected[id]).length,
    [allSelectableIds, selected]
  );
  const selectedRecipients = filtered.filter((r) => selected[r.id]);
  const previewRecipient = selectedRecipients[0] ?? filtered[0] ?? null;

  const toggleAll = (checked: boolean) => {
    const next: Record<string, boolean> = {};
    for (const id of allSelectableIds) next[id] = checked;
    setSelected(next);
  };

  async function sendSelected() {
    if (!selectedCount) { setMsg("Selecione pelo menos um destinatário."); return; }
    if (!subjectTpl.trim() || !bodyTpl.trim()) { setMsg("Preencha assunto e mensagem."); return; }
    setSending(true);
    setMsg(null);
    try {
      const toSend = filtered.filter((r) => selected[r.id]);
      const sentCount = await emailService.sendEmails(toSend, subjectTpl, bodyTpl, statusFilter, search, audience);
      setMsg(`Enfileiradas ${sentCount} mensagens. O serviço de envio tratará do resto ✅`);
    } catch (e: any) {
      setMsg(e?.message ?? "Falha ao enfileirar emails.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-xl font-semibold mb-4">Email Center</h1>

      {/* Audience selector */}
      <div className="flex gap-2 mb-4">
        {(["studyroom", "transport", "all"] as Audience[]).map((a) => (
          <button
            key={a}
            onClick={() => setAudience(a)}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              audience === a
                ? "bg-emerald-600 text-white"
                : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
            }`}
          >
            {a === "studyroom" ? "Sala de Estudo" : a === "transport" ? "Transporte" : "Todos"}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        {audience !== "transport" && (
          <div>
            <div className="text-xs text-neutral-500 mb-1">Estado</div>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={fieldCls}>
              <option value="">Todos</option>
              <option value="pending">Pendente</option>
              <option value="active">Ativo</option>
              <option value="cancelled">Cancelado</option>
            </select>
          </div>
        )}
        <div>
          <div className="text-xs text-neutral-500 mb-1">Pesquisar</div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={fieldCls}
            placeholder="Nome, email, escola…"
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
                {audience !== "transport" && <th className="px-3 py-2 text-left">Aluno</th>}
                {audience !== "studyroom" && <th className="px-3 py-2 text-left">Crianças</th>}
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Escola</th>
                {audience !== "transport" && <th className="px-3 py-2 text-left">Estado</th>}
                {audience !== "studyroom" && <th className="px-3 py-2 text-left">Mensalidade</th>}
                {audience !== "studyroom" && <th className="px-3 py-2 text-left">Dias</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-neutral-200 hover:bg-neutral-50">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={!!selected[r.id]}
                      onChange={(e) => setSelected((s) => ({ ...s, [r.id]: e.target.checked }))}
                    />
                  </td>
                  {audience !== "transport" && <td className="px-3 py-2">{r.studentName || "—"}</td>}
                  {audience !== "studyroom" && <td className="px-3 py-2">{r.nomes || "—"}</td>}
                  <td className="px-3 py-2 text-neutral-600">{r.email}</td>
                  <td className="px-3 py-2">{r.escola || r.schoolName || "—"}</td>
                  {audience !== "transport" && <td className="px-3 py-2 capitalize">{r.status || "—"}</td>}
                  {audience !== "studyroom" && <td className="px-3 py-2">{r.mensalidade || "—"}</td>}
                  {audience !== "studyroom" && <td className="px-3 py-2 text-xs">{r.dias || "—"}</td>}
                </tr>
              ))}
              {!filtered.length && !loading && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-neutral-500">
                    Sem resultados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* RIGHT: composer + preview */}
        <div className="rounded border border-neutral-200 p-3 space-y-3 bg-white">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-neutral-800">Compositor</div>
            <div className="flex items-center gap-2">
              <div className="text-xs text-neutral-500">
                Selecionados: <b>{selectedCount}</b>
              </div>
              {previewRecipient && (
                <button
                  onClick={() => setPreviewOpen((o) => !o)}
                  className="text-xs text-emerald-600 underline"
                >
                  {previewOpen ? "Fechar pré-visualização" : "Pré-visualizar"}
                </button>
              )}
            </div>
          </div>

          {previewOpen && previewRecipient ? (
            <div className="space-y-2">
              <div className="text-xs text-neutral-500 mb-1">
                Pré-visualização para: <b>{previewRecipient.nomes || previewRecipient.studentName || previewRecipient.email}</b>
              </div>
              <div className="border border-neutral-200 rounded p-2 bg-neutral-50 text-xs text-neutral-700 font-medium">
                {applyTokens(subjectTpl, previewRecipient as any)}
              </div>
              <div
                className="border border-neutral-200 rounded p-2 bg-white text-xs text-neutral-800 max-h-64 overflow-y-auto"
                dangerouslySetInnerHTML={{ __html: applyTokens(bodyTpl, previewRecipient as any) }}
              />
              <button onClick={() => setPreviewOpen(false)} className="text-xs text-neutral-400 underline">
                Editar
              </button>
            </div>
          ) : (
            <>
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
                  Mensagem (HTML). Variáveis:{" "}
                  <span className="text-[11px] text-neutral-500">
                    {AUDIENCE_VARS[audience].map((v) => `{{${v}}}`).join(" ")}
                  </span>
                </div>
                <textarea
                  value={bodyTpl}
                  onChange={(e) => setBodyTpl(e.target.value)}
                  rows={10}
                  className={`${fieldCls} font-mono text-xs`}
                />
              </div>
            </>
          )}

          <button
            className="w-full px-3 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-60 text-sm"
            disabled={sending || selectedCount === 0}
            onClick={sendSelected}
          >
            {sending ? "A enviar…" : `Enviar para ${selectedCount || 0} destinatário(s)`}
          </button>

          {msg && (
            <div className={`text-xs ${msg.includes("✅") ? "text-emerald-600" : "text-red-600"}`}>
              {msg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
