import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../lib/firebase';
import { Cloud, RefreshCw, AlertCircle } from 'lucide-react';

interface GcpProjectCost {
  projectId: string;
  projectName: string;
  costEur: number;
}

interface GcpCostData {
  totalCostEur: number;
  byProject: GcpProjectCost[];
  period: string;
  fetchedAt: number;
  configured: boolean;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n);

const periodLabel = (p: string) => {
  const [y, m] = p.split('-');
  const d = new Date(parseInt(y), parseInt(m) - 1);
  return d.toLocaleString('pt-PT', { month: 'long', year: 'numeric' });
};

export function GcpCostCard() {
  const [data, setData] = useState<GcpCostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCosts = async () => {
    setLoading(true);
    setError(null);
    try {
      const fn = httpsCallable<void, GcpCostData>(functions, 'getGcpCosts');
      const res = await fn();
      setData(res.data);
    } catch (e: any) {
      setError(e.message ?? 'Erro ao obter custos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchCosts(); }, []);

  return (
    <div className="border border-zinc-700 rounded-lg p-3 bg-zinc-900/60 text-xs">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-1.5 text-zinc-400 font-medium">
          <Cloud size={13} /> GCP
        </span>
        <button
          onClick={fetchCosts}
          disabled={loading}
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
          title="Atualizar"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && !data && (
        <div className="text-zinc-600 text-center py-1">a carregar...</div>
      )}

      {error && (
        <div className="flex items-center gap-1 text-red-400">
          <AlertCircle size={11} /> {error}
        </div>
      )}

      {data && !data.configured && (
        <div className="text-zinc-500 leading-tight">
          <p className="text-amber-400/80 mb-1">Export não configurado</p>
          <p>Ative o <a
            href="https://console.cloud.google.com/billing/012710-30B4D5-DCC57E/export"
            target="_blank" rel="noopener noreferrer"
            className="underline text-blue-400"
          >BigQuery Export</a> para o dataset <code>rainbow-prod-2454b:billing_export</code>.</p>
        </div>
      )}

      {data && data.configured && (
        <>
          <div className="mb-2">
            <div className="text-zinc-500 mb-0.5">{periodLabel(data.period)}</div>
            <div className="text-lg font-semibold text-white">{fmt(data.totalCostEur)}</div>
          </div>

          {data.byProject.length > 0 && (
            <div className="space-y-1 border-t border-zinc-800 pt-2">
              {data.byProject.slice(0, 5).map(p => (
                <div key={p.projectId} className="flex justify-between gap-2">
                  <span className="text-zinc-500 truncate flex-1" title={p.projectName}>
                    {p.projectName}
                  </span>
                  <span className="text-zinc-300 tabular-nums whitespace-nowrap">{fmt(p.costEur)}</span>
                </div>
              ))}
            </div>
          )}

          {data.fetchedAt && (
            <div className="text-zinc-700 mt-1.5 text-right">
              {new Date(data.fetchedAt).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
