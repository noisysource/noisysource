import { useState } from 'react';
import { X, Trash2, ExternalLink, Send } from 'lucide-react';
import {
  ASSIGNEES, PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, SYSTEMS_BOARD_ID,
  type Board, type Card, type CardLink,
} from '@shared/lib/kanban';
import { commentOn, deleteCard, updateCard, useActivity } from '../lib/data';

const field = 'w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-600';
const lbl = 'block text-[11px] font-medium uppercase tracking-wide text-zinc-500 mb-1';

const linksToText = (links: CardLink[]) => links.map((l) => `${l.label} | ${l.url}`).join('\n');
function textToLinks(text: string): CardLink[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [a, b] = line.split('|').map((s) => s.trim());
      return b ? { label: a, url: b } : { label: a.replace(/^https?:\/\//, '').slice(0, 60), url: a };
    });
}

function when(ms: number) {
  return new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function CardDialog({ card, boards, onClose, onError }: {
  card: Card;
  boards: Board[];
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const activity = useActivity(card.id);
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [status, setStatus] = useState(card.status);
  const [priority, setPriority] = useState(card.priority);
  const [assignee, setAssignee] = useState<string>(card.assignee ?? '');
  const [boardId, setBoardId] = useState(card.boardId);
  const [roadmap, setRoadmap] = useState(card.roadmap);
  const [labels, setLabels] = useState(card.labels.join(', '));
  const [links, setLinks] = useState(linksToText(card.links));
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await updateCard(card, {
        title, description, status, priority, boardId, roadmap,
        assignee: (assignee || null) as Card['assignee'],
        labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
        links: textToLinks(links),
      });
      onClose();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendComment() {
    if (!comment.trim()) return;
    try {
      await commentOn(card.id, comment);
      setComment('');
    } catch (err) {
      onError((err as Error).message);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${card.title}" and its history? This can't be undone.`)) return;
    try {
      await deleteCard(card.id);
      onClose();
    } catch (err) {
      onError((err as Error).message);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-10" onMouseDown={onClose}>
      <div
        className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="flex-1 bg-transparent text-lg font-medium outline-none" />
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800" aria-label="Close"><X size={18} /></button>
        </div>

        <div className="grid gap-5 p-5 md:grid-cols-[1fr_14rem]">
          <div className="space-y-4">
            <div>
              <label className={lbl}>Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={8}
                placeholder="What needs doing, acceptance criteria, notes for the agent…" className={`${field} font-mono text-[13px]`} />
            </div>
            <div>
              <label className={lbl}>Links (one per line: label | url)</label>
              <textarea value={links} onChange={(e) => setLinks(e.target.value)} rows={2}
                placeholder="PR #170 | https://github.com/noisysource/noisysource/pull/170" className={`${field} font-mono text-[12px]`} />
              {card.links.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {card.links.map((l) => (
                    <a key={l.url} href={l.url} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:text-white">
                      <ExternalLink size={11} /> {l.label}
                    </a>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className={lbl}>Activity</label>
              <div className="flex gap-2">
                <input value={comment} onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void sendComment()} placeholder="Add a comment" className={field} />
                <button onClick={() => void sendComment()} className="rounded-lg bg-zinc-800 px-3 text-zinc-300 hover:bg-zinc-700" aria-label="Send comment">
                  <Send size={14} />
                </button>
              </div>
              <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto">
                {activity.map((a) => (
                  <li key={a.id} className="text-xs leading-relaxed">
                    <span className="font-medium text-zinc-300">{a.by}</span>{' '}
                    <span className="text-zinc-500">{a.kind === 'comment' ? 'commented' : a.kind} · {when(a.at)}</span>
                    <p className={a.kind === 'comment' ? 'mt-0.5 whitespace-pre-wrap text-zinc-200' : 'text-zinc-400'}>{a.text}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <aside className="space-y-3">
            <div>
              <label className={lbl}>Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value as Card['status'])} className={field}>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value as Card['priority'])} className={field}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>Assignee</label>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={field}>
                <option value="">Nobody</option>
                {ASSIGNEES.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>Board</label>
              <select value={boardId} onChange={(e) => setBoardId(e.target.value)} className={field}>
                {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <label className={`flex items-center gap-2 text-sm ${boardId === SYSTEMS_BOARD_ID ? 'opacity-50' : ''}`}>
              <input type="checkbox" checked={roadmap || boardId === SYSTEMS_BOARD_ID} disabled={boardId === SYSTEMS_BOARD_ID}
                onChange={(e) => setRoadmap(e.target.checked)} />
              Show on All systems roadmap
            </label>
            <div>
              <label className={lbl}>Labels (comma separated)</label>
              <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug, ui" className={field} />
            </div>
            <p className="pt-1 text-[11px] leading-relaxed text-zinc-500">
              Created by {card.createdBy} · {when(card.createdAt)}<br />
              Updated by {card.updatedBy} · {when(card.updatedAt)}<br />
              <span className="select-all font-mono">id {card.id}</span>
            </p>
            <div className="flex gap-2 pt-2">
              <button onClick={() => void save()} disabled={busy}
                className="flex-1 rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50">
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => void remove()} className="rounded-lg border border-zinc-800 px-3 text-zinc-400 hover:border-red-500/50 hover:text-red-400" aria-label="Delete card">
                <Trash2 size={15} />
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
