import { useEffect, useState } from 'react';
import { useUser } from '@shared/hooks';
import { Campaign, OutboxEmail, listCampaigns, listCampaignEmails, latestPerRecipient, resend, markSkipped } from './emailStore';
import { Draft } from './EmailComposer';

const STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: 'Na fila', cls: 'bg-gray-100 text-gray-700' },
  processing: { label: 'A enviar', cls: 'bg-blue-100 text-blue-800' },
  sent: { label: 'Enviado', cls: 'bg-green-100 text-green-800' },
  error: { label: 'Falhou', cls: 'bg-red-100 text-red-800' },
  skipped: { label: 'Ignorado', cls: 'bg-gray-100 text-gray-500' },
};
const Tag = ({ status }: { status: string }) => {
  const s = STATUS[status] ?? { label: status, cls: 'bg-gray-100 text-gray-600' };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${s.cls}`}>{s.label}</span>;
};
const fmt = (d?: Date) => d ? d.toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : '';

// Queued/processing for over 10 min means the sender died mid-flight (e.g. the
// 2026-10-01 out-of-memory crash) and nothing will move it on, so allow a resend.
const STUCK_MS = 10 * 60 * 1000;
const isStuck = (e: OutboxEmail) =>
  ['queued', 'processing'].includes(e.status) && !!e.createdAt && Date.now() - e.createdAt.getTime() > STUCK_MS;

function CampaignEmails({ campaign, onDuplicate }: { campaign: Campaign; onDuplicate: (d: Draft) => void }) {
  const me = useUser()?.email ?? '';
  const [emails, setEmails] = useState<OutboxEmail[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => listCampaignEmails(campaign.id).then(e => setEmails(latestPerRecipient(e))).catch(e => setErr(e.message));
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [campaign.id]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); await reload(); } catch (e: any) { setErr(e?.message ?? 'Erro'); } finally { setBusy(false); }
  };
  const failed = emails?.filter(e => e.status === 'error') ?? [];

  return (
    <div className="border-t border-gray-100 px-4 py-3 space-y-2 bg-gray-50">
      <div className="flex flex-wrap gap-3 text-sm">
        {failed.length > 0 && (
          <button disabled={busy} onClick={() => {
            if (window.confirm(`Reenviar ${failed.length} email(s) que falharam, com o mesmo conteúdo?`)) act(() => resend(failed, me));
          }} className="text-blue-600 hover:underline disabled:opacity-50">Reenviar os {failed.length} que falharam</button>
        )}
        <button onClick={() => onDuplicate({ subject: campaign.subjectTpl, body: campaign.bodyTpl, audience: campaign.audience })}
          className="text-blue-600 hover:underline">Duplicar (editar e enviar com dados atuais)</button>
        <button disabled={busy} onClick={() => act(async () => {})} className="text-gray-500 hover:underline ml-auto">Atualizar</button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {!emails ? <p className="text-sm text-gray-500">A carregar…</p> : emails.length === 0 ? (
        <p className="text-sm text-gray-400">Sem emails nesta campanha.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded divide-y divide-gray-100">
          {emails.map(e => (
            <div key={e.id} className="text-sm">
              <div className="flex items-center gap-3 px-3 py-1.5">
                <button onClick={() => setOpen(open === e.id ? null : e.id)} className="flex-1 min-w-0 text-left truncate hover:underline">
                  {e.toName || e.to} <span className="text-xs text-gray-500">{e.to}</span>
                  {e.resendOf && <span className="text-xs text-gray-400"> · reenvio</span>}
                </button>
                <span className="text-xs text-gray-400 hidden sm:inline">{fmt(e.sentAt ?? e.createdAt)}</span>
                <Tag status={e.status} />
                {(!['queued', 'processing'].includes(e.status) || isStuck(e)) && (
                  <button disabled={busy} onClick={() => {
                    const warn = isStuck(e) ? '\n\nEste email ficou preso a enviar. Pode já ter chegado: confirme primeiro na pasta Enviados do Gmail.' : '';
                    if (window.confirm(`Reenviar para ${e.to}?${warn}`)) act(() => resend([e], me));
                  }} className="text-xs text-blue-600 hover:underline disabled:opacity-50">Reenviar</button>
                )}
                {e.status === 'error' && (
                  <button disabled={busy} onClick={() => act(() => markSkipped(e.id, me))}
                    className="text-xs text-gray-500 hover:underline disabled:opacity-50">Ignorar</button>
                )}
              </div>
              {e.error && <p className="px-3 pb-1 text-xs text-red-700 break-words">{e.error}</p>}
              {open === e.id && (
                <div className="px-3 pb-3">
                  <p className="text-xs text-gray-500 mb-1">Assunto: <b className="text-gray-800">{e.subject}</b></p>
                  <div className="email-preview border border-gray-100 rounded p-3 bg-white"
                    dangerouslySetInnerHTML={{ __html: e.html ?? (e.text ?? '').replace(/\n/g, '<br/>') }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function EmailHistory({ onDuplicate }: { onDuplicate: (d: Draft) => void }) {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { listCampaigns().then(setCampaigns).catch(e => setErr(e.message)); }, []);

  if (err) return <p className="text-red-600">{err}</p>;
  if (!campaigns) return <p className="text-gray-500">A carregar…</p>;
  if (campaigns.length === 0) return <p className="text-gray-400">Ainda não foram enviados emails.</p>;

  return (
    <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
      {campaigns.map(c => (
        <div key={c.id}>
          <button onClick={() => setOpen(open === c.id ? null : c.id)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50">
            <span className="text-gray-400 text-xs w-3">{open === c.id ? '▾' : '▸'}</span>
            <span className="flex-1 min-w-0 truncate text-sm font-medium text-gray-800">{c.subjectTpl.replace(/\{\{(\w+)\}\}/g, '[$1]') || '(sem assunto)'}</span>
            <span className="text-xs text-gray-500 hidden sm:inline">{c.createdBy && c.createdBy !== 'admin-ui' ? c.createdBy : ''}</span>
            <span className="text-xs text-gray-500">{c.totalPlanned ?? '?'} dest.</span>
            <span className="text-xs text-gray-500 w-28 text-right">{fmt(c.createdAt)}</span>
          </button>
          {open === c.id && <CampaignEmails campaign={c} onDuplicate={onDuplicate} />}
        </div>
      ))}
    </div>
  );
}
