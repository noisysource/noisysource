import { Fragment, useState, useEffect, useMemo } from 'react';
import { getDocs, query, orderBy, limit } from 'firebase/firestore';
import { col } from '../../lib/db';

// Failed actions reported by the app (src/lib/clientErrors.ts) — things a user
// tried that didn't land, often without them seeing any error. The daily digest
// email (functions clientErrorsDigest) summarises the parent-facing ones.

interface Report {
  id: string;
  userId: string;
  email: string;
  impersonatingFamilyId: string | null;
  action: string;
  code: string;
  message: string;
  route: string;
  userAgent: string;
  mode: string;
  context?: Record<string, unknown>;
  createdAt: Date | null;
}

const PAGE_SIZE = 200;

const fmt = (d: Date | null) => d
  ? d.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—';

export default function ClientErrorsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parentsOnly, setParentsOnly] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(query(col('clientErrors'), orderBy('createdAt', 'desc'), limit(PAGE_SIZE)));
        setReports(snap.docs.map(d => {
          const x = d.data();
          return { ...x, id: d.id, createdAt: x.createdAt?.toDate?.() ?? null } as Report;
        }));
      } catch (err) {
        console.error('[ClientErrorsPage] load failed', err);
        setError('Não foi possível carregar os erros.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const visible = useMemo(() => parentsOnly
    ? reports.filter(r => !r.route?.startsWith('/admin') && !r.impersonatingFamilyId)
    : reports, [reports, parentsOnly]);

  const people = new Set(visible.map(r => r.userId)).size;

  return (
    <div className="p-6 max-w-6xl">
      <h1 className="text-2xl font-bold mb-1">Erros dos clientes</h1>
      <p className="text-sm text-gray-500 mb-4">
        Ações que falharam (inscrições, pagamentos, perfil…), muitas vezes sem o cliente ver um erro.
        Últimos {PAGE_SIZE} registos; são apagados ao fim de 90 dias.
      </p>

      <label className="inline-flex items-center gap-2 text-sm mb-4">
        <input type="checkbox" checked={parentsOnly} onChange={e => setParentsOnly(e.target.checked)} />
        Só clientes (sem área de administração nem sessões a personificar)
      </label>

      {loading ? (
        <p className="text-gray-500">A carregar...</p>
      ) : error ? (
        <p className="text-red-600">{error}</p>
      ) : visible.length === 0 ? (
        <p className="text-gray-500 bg-white border border-gray-200 rounded-lg p-6 text-center">Sem erros registados. 🎉</p>
      ) : (
        <>
          <p className="text-sm text-gray-600 mb-2">{visible.length} erro(s), {people} pessoa(s)</p>
          <div className="bg-white border border-gray-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="px-3 py-2">Quando</th>
                  <th className="px-3 py-2">Quem</th>
                  <th className="px-3 py-2">Ação</th>
                  <th className="px-3 py-2">Erro</th>
                  <th className="px-3 py-2">Página</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map(r => (
                  <Fragment key={r.id}>
                    <tr onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                      className="hover:bg-gray-50 cursor-pointer align-top">
                      <td className="px-3 py-2 whitespace-nowrap">{fmt(r.createdAt)}</td>
                      <td className="px-3 py-2">
                        {r.email || r.userId}
                        {r.impersonatingFamilyId && <span className="ml-1 text-xs text-amber-700">(a personificar)</span>}
                      </td>
                      <td className="px-3 py-2">{r.action}</td>
                      <td className="px-3 py-2">
                        {r.code && <span className="font-mono text-xs bg-red-50 text-red-700 px-1.5 py-0.5 rounded mr-1">{r.code}</span>}
                        <span className="text-gray-700">{r.message.length > 120 ? r.message.slice(0, 120) + '…' : r.message}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500 break-all">{r.route}</td>
                    </tr>
                    {expanded === r.id && (
                      <tr className="bg-gray-50">
                        <td colSpan={5} className="px-3 py-2 text-xs text-gray-600 space-y-1">
                          <div><b>Mensagem:</b> {r.message}</div>
                          <div><b>userId:</b> <span className="font-mono">{r.userId}</span>
                            {r.impersonatingFamilyId && <> · <b>família personificada:</b> <span className="font-mono">{r.impersonatingFamilyId}</span></>}
                          </div>
                          {r.context && <div><b>Contexto:</b> <span className="font-mono">{JSON.stringify(r.context)}</span></div>}
                          <div><b>Browser:</b> {r.userAgent} · <b>build:</b> {r.mode}</div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
