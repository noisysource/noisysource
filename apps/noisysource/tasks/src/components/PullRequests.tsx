import { useCallback, useEffect, useState } from 'react';
import {
  Check, CircleDot, Copy, ExternalLink, GitMerge, GitPullRequest, Loader2, RefreshCw, X,
} from 'lucide-react';
import {
  checkoutCommands, checksVerdict, mergeBlocker, mergeWarning, prRefs, type Card, type PrStatus,
} from '@shared/lib/kanban';
import { errText, fetchPrs, mergePr, type PrResult } from '../lib/github';

const VERDICT: Record<string, { text: string; cls: string }> = {
  passed: { text: 'checks passed', cls: 'text-emerald-400' },
  failed: { text: 'a check failed', cls: 'text-red-400' },
  pending: { text: 'checks running', cls: 'text-amber-300' },
  none: { text: 'no checks', cls: 'text-zinc-400' },
  unknown: { text: "couldn't read checks", cls: 'text-amber-300' },
};

function CopyBlock({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="relative mt-2">
      <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 pr-9 text-[11.5px] leading-relaxed text-zinc-300">{text}</pre>
      <button
        onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}
        className="absolute right-1.5 top-1.5 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        aria-label="Copy"
      >
        {done ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

export function Pr({ pr, cardId, onMerged, onError }: {
  pr: PrStatus; cardId: string; onMerged: (toDone: boolean) => void; onError: (m: string) => void;
}) {
  const [showChecks, setShowChecks] = useState(false);
  const [merging, setMerging] = useState(false);
  const verdict = checksVerdict(pr.checks);
  const blocker = mergeBlocker(pr);
  const warning = mergeWarning(pr.repo, pr.base);
  const open = pr.state === 'open' && !pr.merged;

  async function merge() {
    const lines = [`Merge ${pr.repo}#${pr.number} "${pr.title}" into ${pr.base}?`];
    if (warning) lines.push('', warning);
    if (!window.confirm(lines.join('\n'))) return;
    const unread = pr.checks === null;
    if (unread && !window.confirm("The board couldn't read this PR's checks. Merge anyway? Check Actions on GitHub first.")) return;
    setMerging(true);
    try {
      const r = await mergePr(cardId, pr.repo, pr.number, unread);
      onMerged(r.movedToDone);
    } catch (e) {
      onError(errText(e));
    } finally {
      setMerging(false);
    }
  }

  return (
    <li className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="flex items-start gap-2">
        {pr.merged ? <GitMerge size={15} className="mt-0.5 text-violet-400" />
          : open ? <GitPullRequest size={15} className="mt-0.5 text-emerald-400" />
          : <X size={15} className="mt-0.5 text-red-400" />}
        <div className="min-w-0 flex-1">
          <a href={pr.url} target="_blank" rel="noreferrer" className="text-sm text-zinc-100 hover:underline">
            {pr.title} <span className="text-zinc-500">#{pr.number}</span>
          </a>
          <p className="mt-0.5 font-mono text-[11px] text-zinc-500">
            {pr.repo} · {pr.base} ← {pr.head}
            {pr.draft && ' · draft'}
            {pr.merged ? ' · merged' : !open ? ' · closed' : ''}
          </p>
        </div>
        <a href={pr.url} target="_blank" rel="noreferrer" className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" aria-label="Open on GitHub">
          <ExternalLink size={13} />
        </a>
      </div>

      {open && (
        <>
          <button onClick={() => setShowChecks(!showChecks)} className={`mt-2 inline-flex items-center gap-1.5 text-xs ${VERDICT[verdict].cls}`}>
            <CircleDot size={11} /> {VERDICT[verdict].text}
            {pr.checks && pr.checks.length > 0 && <span className="text-zinc-500">({pr.checks.length}) {showChecks ? '▴' : '▾'}</span>}
          </button>
          {showChecks && pr.checks && (
            <ul className="mt-1.5 space-y-0.5">
              {pr.checks.map((c) => (
                <li key={c.url + c.name} className="flex items-center gap-2 text-[11px]">
                  <span className={
                    c.status !== 'completed' ? 'text-amber-300'
                      : ['success', 'skipped', 'neutral'].includes(c.conclusion ?? '') ? 'text-emerald-400' : 'text-red-400'
                  }>●</span>
                  <a href={c.url} target="_blank" rel="noreferrer" className="truncate text-zinc-400 hover:text-zinc-200">{c.name}</a>
                  <span className="ml-auto text-zinc-600">{c.status === 'completed' ? c.conclusion : c.status}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-zinc-500">Check out to test locally</p>
          <CopyBlock text={checkoutCommands(pr.repo, pr.head)} />

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => void merge()}
              disabled={!!blocker || merging}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {merging ? <Loader2 size={13} className="animate-spin" /> : <GitMerge size={13} />}
              Merge into {pr.base}
            </button>
            {blocker && <span className="text-[11px] text-zinc-500">Can't merge: {blocker}</span>}
          </div>
          {!blocker && warning && <p className="mt-1.5 text-[11px] leading-relaxed text-amber-300/80">{warning}</p>}
        </>
      )}
    </li>
  );
}

/** The card's linked PRs, asked for when the card opens (nothing polls). */
export function PullRequests({ card, onError }: { card: Card; onError: (m: string) => void }) {
  const refs = prRefs(card);
  const key = refs.map((r) => `${r.repo}#${r.number}`).join(',');
  const [prs, setPrs] = useState<PrResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!key) return setPrs([]);
    setLoading(true);
    setNote(null);
    try {
      setPrs(await fetchPrs(card.id));
    } catch (e) {
      setNote(errText(e));
      setPrs(null);
    } finally {
      setLoading(false);
    }
  }, [card.id, key]);

  useEffect(() => { void load(); }, [load]);

  if (!refs.length) {
    return (
      <p className="text-xs text-zinc-500">
        No PR linked yet. Add one under Links (e.g. <span className="font-mono">PR #170 | https://github.com/noisysource/noisysource/pull/170</span>).
      </p>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {note && <p className="mb-2 text-xs text-amber-300">{note}</p>}
      <ul className="space-y-2">
        {(prs ?? []).map((p) =>
          'error' in p ? (
            <li key={`${p.repo}#${p.number}`} className="rounded-xl border border-zinc-800 p-3 text-xs text-zinc-400">
              {p.repo}#{p.number}: {p.error}
            </li>
          ) : (
            <Pr key={`${p.repo}#${p.number}`} pr={p} cardId={card.id} onError={onError}
              onMerged={(toDone) => { setNote(toDone ? 'Merged. All PRs are in, so the card moved to Done.' : 'Merged.'); void load(); }} />
          ),
        )}
      </ul>
    </div>
  );
}
