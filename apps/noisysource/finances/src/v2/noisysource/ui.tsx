import type { ReactNode } from 'react';

export function Badge({ children, tone = 'zinc', title }: { children: ReactNode; tone?: 'zinc' | 'amber' | 'emerald' | 'sky' | 'red'; title?: string }) {
  const tones = {
    zinc: 'bg-zinc-800 text-zinc-300 border-zinc-700',
    amber: 'bg-amber-950/60 text-amber-200 border-amber-800',
    emerald: 'bg-emerald-950/60 text-emerald-200 border-emerald-800',
    sky: 'bg-sky-950/60 text-sky-200 border-sky-800',
    red: 'bg-red-950/60 text-red-200 border-red-800',
  };
  return <span title={title} className={`inline-block whitespace-nowrap rounded border px-1.5 py-0 text-[11px] leading-5 ${tones[tone]}`}>{children}</span>;
}

export function Card({ title, value, sub, tone }: { title: string; value: string; sub: string; tone?: 'red' }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs uppercase tracking-wider text-zinc-500">{title}</div>
      <div className={`mt-1 text-2xl font-bold ${tone === 'red' ? 'text-red-300' : ''}`}>{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{sub}</div>
    </div>
  );
}
