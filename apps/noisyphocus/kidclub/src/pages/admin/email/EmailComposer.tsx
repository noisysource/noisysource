import { useEffect, useMemo, useRef, useState } from 'react';
import { useUser } from '@shared/hooks';
import { useAdminData } from '../subscriptions/useAdminData';
import {
  AudienceFilters, DEFAULT_AUDIENCE, Recipient, buildAudience, prepareSource, schoolOptions, schoolKey,
  STATUS_OPTIONS, SERVICE_OPTIONS, FLAG_OPTIONS,
} from './audience';
import { renderBody, renderSubject, usedVariables, VARIABLE_LABEL, VariableKey, EXAMPLE_VALUES } from './variables';
import { BodyEditor, VariablePalette, insertVariable, useSyncContent, useVariableEditor } from './VariableEditor';
import {
  EmailTemplate, listTemplates, saveTemplate, deleteTemplate, sendTest, sendCampaign, MAX_RECIPIENTS_PER_SEND,
} from './emailStore';

export interface Draft { subject: string; body: string; audience?: AudienceFilters }

function Chip({ on, active, children }: { on: () => void; active: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={on}
      className={`text-xs px-2.5 py-1 rounded-full border ${active ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:border-gray-400'}`}>
      {children}
    </button>
  );
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

export default function EmailComposer({ draft, draftVersion }: { draft: Draft | null; draftVersion: number }) {
  const user = useUser();
  const me = user?.email ?? '';
  const data = useAdminData();

  // ── Message ────────────────────────────────────────────────────────────────
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('<p></p>');
  const [docVersion, setDocVersion] = useState(0);
  const editor = useVariableEditor(body, setBody);
  useSyncContent(editor, body, docVersion);
  const subjectRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<'subject' | 'body'>('body');

  const load = (d: { subject: string; body: string }) => {
    setSubject(d.subject);
    setBody(d.body);
    setDocVersion(v => v + 1);
  };

  // ── Templates ──────────────────────────────────────────────────────────────
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>('');
  const refreshTemplates = () => listTemplates().then(setTemplates).catch(() => setTemplates([]));
  useEffect(() => { refreshTemplates(); }, []);
  const currentTemplate = templates.find(t => t.id === templateId);

  // ── Audience ───────────────────────────────────────────────────────────────
  const [aud, setAud] = useState<AudienceFilters>(DEFAULT_AUDIENCE);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!draft) return;
    load(draft);
    if (draft.audience) setAud({ ...DEFAULT_AUDIENCE, ...draft.audience });
    setTemplateId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftVersion]);

  const src = useMemo(
    () => prepareSource({ items: data.items, families: data.families, children: data.children, bills: data.bills }),
    [data.items, data.families, data.children, data.bills],
  );
  const schools = useMemo(() => schoolOptions(src), [src]);
  const audience = useMemo(() => buildAudience(src, aud), [src, aud]);
  const noEmail = audience.filter(r => !r.email);
  const selected = audience.filter(r => r.email && !excluded.has(r.familyKey));

  const used = usedVariables(subject, body);
  const missing = useMemo(() => selected
    .map(r => ({ r, keys: used.filter(k => !r.values[k]) }))
    .filter(x => x.keys.length > 0), [selected, used]);

  // ── Preview ────────────────────────────────────────────────────────────────
  const [previewKey, setPreviewKey] = useState<string>('');
  const previewRecipient: Recipient | undefined = selected.find(r => r.familyKey === previewKey) ?? selected[0];
  const previewValues = previewRecipient?.values ?? EXAMPLE_VALUES;

  // ── Actions ────────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const bodyEmpty = !editor || editor.isEmpty;
  const canSend = !!subject.trim() && !bodyEmpty && selected.length > 0 && !busy;

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); }
    catch (err: any) { setMsg({ ok: false, text: err?.message ?? 'Erro desconhecido' }); }
    finally { setBusy(null); }
  };

  const onInsert = (key: VariableKey) => {
    if (lastFocus.current === 'subject' && subjectRef.current) {
      const el = subjectRef.current;
      const at = el.selectionStart ?? subject.length;
      const token = `{{${key}}}`;
      setSubject(subject.slice(0, at) + token + subject.slice(el.selectionEnd ?? at));
      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(at + token.length, at + token.length); });
    } else {
      insertVariable(editor, key);
    }
  };

  const saveAs = () => run('template', async () => {
    const name = window.prompt('Nome do modelo', currentTemplate ? `${currentTemplate.name} (cópia)` : '');
    if (!name?.trim()) return 'Cancelado.';
    const id = await saveTemplate({ name: name.trim(), subject, body }, me);
    await refreshTemplates(); setTemplateId(id);
    return `Modelo "${name.trim()}" guardado.`;
  });
  const saveCurrent = () => run('template', async () => {
    if (!currentTemplate) return '';
    await saveTemplate({ id: currentTemplate.id, name: currentTemplate.name, subject, body }, me);
    await refreshTemplates();
    return `Modelo "${currentTemplate.name}" atualizado.`;
  });
  const removeTemplate = () => run('template', async () => {
    if (!currentTemplate || !window.confirm(`Eliminar o modelo "${currentTemplate.name}"?`)) return 'Cancelado.';
    await deleteTemplate(currentTemplate.id);
    await refreshTemplates(); setTemplateId('');
    return 'Modelo eliminado.';
  });

  const onTest = () => run('test', async () => {
    if (!me) throw new Error('Sem email de utilizador.');
    if (!previewRecipient) throw new Error('Escolha pelo menos um destinatário para o teste.');
    await sendTest(me, subject, body, previewRecipient, me);
    return `Teste enviado para ${me} (com os dados de ${previewRecipient.label}).`;
  });

  const onSend = () => run('send', async () => {
    const warn = missing.length ? `\n\n⚠ ${missing.length} família(s) têm variáveis sem valor (ficam em branco).` : '';
    if (!window.confirm(`Enviar "${subject}" para ${selected.length} família(s)?${warn}\n\nNão é possível cancelar depois de enviado.`)) return 'Cancelado.';
    const id = await sendCampaign(subject, body, aud, selected, me);
    setExcluded(new Set());
    return `Enviado para ${selected.length} família(s). Acompanhe em Histórico (campanha ${id.slice(0, 6)}).`;
  });

  if (data.isLoading) return <p className="text-gray-500">A carregar famílias…</p>;
  if (data.error) return <p className="text-red-600">{data.error}</p>;

  return (
    <div className="space-y-6">
      {/* ── Message ── */}
      <section className="grid lg:grid-cols-[1fr_280px] gap-4">
        <div className="space-y-3 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <select value={templateId} onChange={e => {
              const t = templates.find(x => x.id === e.target.value);
              setTemplateId(e.target.value);
              if (t) load(t);
            }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white">
              <option value="">— Modelo —</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {currentTemplate && (
              <button onClick={saveCurrent} disabled={!!busy} className="text-sm text-blue-600 hover:underline">Atualizar modelo</button>
            )}
            <button onClick={saveAs} disabled={!!busy} className="text-sm text-blue-600 hover:underline">Guardar como modelo…</button>
            {currentTemplate && (
              <button onClick={removeTemplate} disabled={!!busy} className="text-sm text-red-600 hover:underline">Eliminar</button>
            )}
          </div>

          <input ref={subjectRef} value={subject} onChange={e => setSubject(e.target.value)}
            onFocus={() => { lastFocus.current = 'subject'; }}
            placeholder="Assunto"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" />

          <div onFocusCapture={() => { lastFocus.current = 'body'; }}>
            <BodyEditor editor={editor} />
          </div>
        </div>

        <aside className="bg-gray-50 border border-gray-200 rounded-lg p-3 h-fit">
          <p className="text-sm font-semibold text-gray-700 mb-1">Variáveis</p>
          <p className="text-xs text-gray-500 mb-3">Clique para inserir onde está o cursor (assunto ou texto), ou arraste para o sítio certo.</p>
          <VariablePalette onInsert={onInsert} />
        </aside>
      </section>

      {/* ── Audience ── */}
      <section className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="font-semibold text-gray-800">Destinatários</h2>
          <p className="text-sm text-gray-600">
            <b>{selected.length}</b> família(s)
            {excluded.size > 0 && <> · {excluded.size} excluída(s)</>}
            {noEmail.length > 0 && <> · {noEmail.length} sem email</>}
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-xs text-gray-500 w-20">Inscrições</span>
          {STATUS_OPTIONS.map(o => <Chip key={o.value} active={aud.statuses.includes(o.value)} on={() => setAud({ ...aud, statuses: toggle(aud.statuses, o.value) })}>{o.label}</Chip>)}
          <span className="mx-1 text-gray-300">|</span>
          {SERVICE_OPTIONS.map(o => <Chip key={o.value} active={aud.services.includes(o.value)} on={() => setAud({ ...aud, services: toggle(aud.services, o.value) })}>{o.label}</Chip>)}
          <span className="mx-1 text-gray-300">|</span>
          <Chip active={aud.showEmpty} on={() => setAud({ ...aud, showEmpty: !aud.showEmpty })}>Famílias sem inscrições</Chip>
        </div>
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-xs text-gray-500 w-20">Situação</span>
          {FLAG_OPTIONS.map(o => <Chip key={o.value} active={aud.flags.includes(o.value)} on={() => setAud({ ...aud, flags: toggle(aud.flags, o.value) })}>{o.label}</Chip>)}
        </div>
        {schools.length > 0 && (
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs text-gray-500 w-20">Escola</span>
            {schools.map(s => {
              const on = aud.schools.some(x => schoolKey(x) === schoolKey(s));
              return <Chip key={s} active={on} on={() => setAud({ ...aud, schools: on ? aud.schools.filter(x => schoolKey(x) !== schoolKey(s)) : [...aud.schools, s] })}>{s}</Chip>;
            })}
          </div>
        )}
        <input value={aud.search} onChange={e => setAud({ ...aud, search: e.target.value })}
          placeholder="Pesquisar (nome, email, escola, morada…)"
          className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm" />
        <p className="text-xs text-gray-500">
          Filtros sem nada escolhido não restringem. Uma família entra se alguma inscrição dela corresponder; as variáveis de crianças e
          inscrições usam só as inscrições que corresponderam.
        </p>

        <div className="max-h-72 overflow-y-auto border border-gray-100 rounded divide-y divide-gray-100">
          {audience.length === 0 && <p className="text-sm text-gray-400 p-3">Nenhuma família corresponde aos filtros.</p>}
          {audience.map(r => {
            const off = !r.email || excluded.has(r.familyKey);
            return (
              <label key={r.familyKey} className={`flex items-center gap-3 px-3 py-1.5 text-sm ${off ? 'text-gray-400' : 'text-gray-800'}`}>
                <input type="checkbox" disabled={!r.email} checked={!off}
                  onChange={() => setExcluded(prev => { const n = new Set(prev); n.has(r.familyKey) ? n.delete(r.familyKey) : n.add(r.familyKey); return n; })} />
                <span className="flex-1 truncate">{r.label}</span>
                <span className="text-xs truncate max-w-[40%]">{r.email ?? 'sem email'}</span>
                {r.values.criancas && <span className="text-xs text-gray-500 truncate max-w-[30%] hidden sm:inline">{r.values.criancas}</span>}
              </label>
            );
          })}
        </div>
        {audience.length > 0 && (
          <div className="flex gap-3 text-xs">
            <button onClick={() => setExcluded(new Set())} className="text-blue-600 hover:underline">Selecionar todas</button>
            <button onClick={() => setExcluded(new Set(audience.map(r => r.familyKey)))} className="text-blue-600 hover:underline">Nenhuma</button>
          </div>
        )}
      </section>

      {/* ── Preview + checks ── */}
      <section className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="font-semibold text-gray-800">Pré-visualização</h2>
          {selected.length > 0 && (
            <select value={previewRecipient?.familyKey ?? ''} onChange={e => setPreviewKey(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1 text-sm bg-white max-w-full">
              {selected.map(r => <option key={r.familyKey} value={r.familyKey}>{r.label}</option>)}
            </select>
          )}
        </div>
        {!previewRecipient && <p className="text-xs text-gray-500">Sem destinatários — a mostrar valores de exemplo.</p>}
        <div className="border border-gray-100 rounded p-3 bg-gray-50">
          <p className="text-sm"><span className="text-gray-500">Para:</span> {previewRecipient?.email ?? '—'}</p>
          <p className="text-sm mb-2"><span className="text-gray-500">Assunto:</span> <b>{renderSubject(subject, previewValues) || '—'}</b></p>
          <div className="email-preview text-sm bg-white border border-gray-100 rounded p-3"
            dangerouslySetInnerHTML={{ __html: renderBody(body, previewValues) }} />
        </div>

        {missing.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
            <p className="font-medium">{missing.length} família(s) sem valor para uma variável usada — fica em branco no email:</p>
            <ul className="mt-1 text-xs space-y-0.5 max-h-32 overflow-y-auto">
              {missing.map(({ r, keys }) => (
                <li key={r.familyKey}>{r.label}: {keys.map(k => VARIABLE_LABEL[k]).join(', ')}</li>
              ))}
            </ul>
            <button onClick={() => setExcluded(prev => new Set([...prev, ...missing.map(m => m.r.familyKey)]))}
              className="mt-2 text-xs text-amber-900 underline">Excluir estas famílias</button>
          </div>
        )}
      </section>

      {/* ── Send ── */}
      <section className="flex flex-wrap items-center gap-3">
        <button onClick={onTest} disabled={!subject.trim() || bodyEmpty || !!busy}
          className="px-4 py-2 rounded-lg border border-gray-300 bg-white text-sm hover:bg-gray-50 disabled:opacity-50">
          {busy === 'test' ? 'A enviar…' : `Enviar teste para mim`}
        </button>
        <button onClick={onSend} disabled={!canSend || selected.length > MAX_RECIPIENTS_PER_SEND}
          className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
          {busy === 'send' ? 'A enviar…' : `Enviar para ${selected.length} família(s)`}
        </button>
        {selected.length > MAX_RECIPIENTS_PER_SEND && (
          <span className="text-sm text-red-600">Máximo {MAX_RECIPIENTS_PER_SEND} por envio — restrinja os filtros.</span>
        )}
        {msg && <span className={`text-sm ${msg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</span>}
      </section>
    </div>
  );
}
