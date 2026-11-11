import { createContext, useContext } from 'react';
import { Outlet } from 'react-router-dom';
import { useNsData, type NsData } from './useNsData';

export const NsDataContext = createContext<NsData | null>(null);

export function useNs(): NsData {
  const v = useContext(NsDataContext);
  if (!v) throw new Error('useNs outside NoisySourceModule');
  return v;
}

/** Loads NoisySource's events once for every page of the module. */
export default function NoisySourceModule() {
  const data = useNsData();
  return (
    <NsDataContext.Provider value={data}>
      {data.error && (
        <div className="mb-4 rounded-md border border-red-800 bg-red-950/50 p-3 text-sm text-red-200">
          Não foi possível ler os eventos: {data.error}
        </div>
      )}
      {data.invalid.length > 0 && (
        <details className="mb-4 rounded-md border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
          <summary>{data.invalid.length} evento(s) inválido(s) ignorado(s)</summary>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {data.invalid.map(i => <li key={i.id}>{i.id}: {i.error}</li>)}
          </ul>
        </details>
      )}
      {data.loading && !data.state ? <p className="text-zinc-400">A carregar eventos…</p>
        : !data.state ? <p className="text-zinc-400">Ainda não há eventos da NoisySource.</p>
        : <Outlet />}
    </NsDataContext.Provider>
  );
}
