import { useMemo, useState, type DragEvent } from 'react';
import { Plus, Map as MapIcon, Bot, User, GitPullRequest, FlaskConical } from 'lucide-react';
import {
  STATUSES, STATUS_LABEL, SYSTEMS_BOARD_ID, isOnRoadmap, orderBetween, prRefs, sortCards,
  type Board, type Card, type Status,
} from '@shared/lib/kanban';
import { createCard, moveCard } from '../lib/data';

const PRIORITY_DOT: Record<string, string> = {
  p0: 'bg-red-500', p1: 'bg-orange-400', p2: 'bg-zinc-500', p3: 'bg-zinc-700',
};

export interface Filters {
  text: string;
  assignee: string;
  apps: string[];
}

interface Props {
  board: Board;
  boards: Board[];
  cards: Card[];
  filters: Filters;
  onOpen: (card: Card) => void;
  onError: (msg: string) => void;
}

export function matches(card: Card, f: Filters): boolean {
  if (f.assignee && (f.assignee === 'none' ? card.assignee !== null : card.assignee !== f.assignee)) return false;
  if (f.apps.length && !f.apps.includes(card.boardId)) return false;
  if (f.text) {
    const t = f.text.toLowerCase();
    if (![card.title, card.description, ...card.labels].some((s) => s.toLowerCase().includes(t))) return false;
  }
  return true;
}

export function BoardView({ board, boards, cards, filters, onOpen, onError }: Props) {
  const isRoadmap = board.id === SYSTEMS_BOARD_ID;
  const boardById = useMemo(() => new Map(boards.map((b) => [b.id, b])), [boards]);
  const visible = useMemo(
    () => cards.filter((c) => (isRoadmap ? isOnRoadmap(c) : c.boardId === board.id)).filter((c) => matches(c, filters)),
    [cards, board.id, isRoadmap, filters],
  );
  const columns = useMemo(() => {
    const by = new Map<Status, Card[]>(STATUSES.map((s) => [s, []]));
    for (const c of visible) by.get(c.status)?.push(c);
    for (const s of STATUSES) by.set(s, sortCards(by.get(s)!));
    return by;
  }, [visible]);

  const [dragId, setDragId] = useState<string | null>(null);
  const [target, setTarget] = useState<{ status: Status; beforeId: string | null } | null>(null);
  const [adding, setAdding] = useState<Status | null>(null);
  const [draft, setDraft] = useState('');

  async function drop(e: DragEvent) {
    e.preventDefault();
    const card = cards.find((c) => c.id === dragId);
    const t = target;
    setDragId(null);
    setTarget(null);
    if (!card || !t) return;
    const col = columns.get(t.status)!.filter((c) => c.id !== card.id);
    const at = t.beforeId ? col.findIndex((c) => c.id === t.beforeId) : col.length;
    const order = orderBetween(col[at - 1]?.order, at >= 0 ? col[at]?.order : undefined);
    try {
      await moveCard(card, t.status, order);
    } catch (err) {
      onError((err as Error).message);
    }
  }

  async function add(status: Status) {
    const title = draft.trim();
    if (!title) return setAdding(null);
    try {
      await createCard({ boardId: board.id, title, status }, columns.get(status)!);
      setDraft('');
    } catch (err) {
      onError((err as Error).message);
    }
  }

  return (
    <div className="flex gap-3 h-full overflow-x-auto pb-2">
      {STATUSES.map((status) => {
        const col = columns.get(status)!;
        const over = target?.status === status;
        return (
          <section
            key={status}
            onDragOver={(e) => {
              // Cards stop their own dragover, so this only fires over the
              // column's empty space: drop at the bottom.
              e.preventDefault();
              if (target?.status !== status || target.beforeId !== null) setTarget({ status, beforeId: null });
            }}
            onDrop={drop}
            className={`flex flex-col w-64 shrink-0 rounded-xl border ${
              over ? 'border-zinc-600 bg-zinc-900' : 'border-zinc-800/80 bg-zinc-900/50'
            }`}
          >
            <header className="flex items-center justify-between px-3 pt-3 pb-2">
              <h2 className={`text-xs font-semibold uppercase tracking-wide ${status === 'testing' ? 'text-amber-300' : 'text-zinc-400'}`}>{STATUS_LABEL[status]}</h2>
              <span className="text-xs text-zinc-500">{col.length}</span>
            </header>
            <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2 min-h-[3rem]">
              {col.map((card) => {
                const app = boardById.get(card.boardId);
                const before = over && target?.beforeId === card.id;
                return (
                  <article
                    key={card.id}
                    draggable
                    onDragStart={(e) => {
                      setDragId(card.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setTarget(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setTarget({ status, beforeId: card.id });
                    }}
                    onClick={() => onOpen(card)}
                    className={`group cursor-pointer rounded-lg border bg-zinc-950 p-3 text-sm transition ${
                      before ? 'border-t-2 border-t-orange-400 border-zinc-800' : 'border-zinc-800 hover:border-zinc-600'
                    } ${dragId === card.id ? 'opacity-40' : ''}`}
                  >
                    <div className="flex items-start gap-2">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[card.priority]}`} title={card.priority} />
                      <p className="flex-1 leading-snug text-zinc-100">{card.title}</p>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
                      {isRoadmap && app && app.id !== SYSTEMS_BOARD_ID && (
                        <span className="rounded px-1.5 py-0.5 font-medium" style={{ background: `${app.color}22`, color: app.color }}>
                          {app.name}
                        </span>
                      )}
                      {!isRoadmap && card.roadmap && (
                        <span className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5" title="On the All systems roadmap">
                          <MapIcon size={10} /> roadmap
                        </span>
                      )}
                      {prRefs(card).length > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-zinc-400" title="Linked pull requests">
                          <GitPullRequest size={11} />{prRefs(card).length}
                        </span>
                      )}
                      {card.status === 'testing' && card.testPlan.trim() && (
                        <span className="inline-flex items-center gap-0.5 text-amber-300" title="Has a test plan"><FlaskConical size={11} /></span>
                      )}
                      {card.labels.map((l) => (
                        <span key={l} className="rounded bg-zinc-800 px-1.5 py-0.5">{l}</span>
                      ))}
                      {card.assignee && (
                        <span className="ml-auto inline-flex items-center gap-1 text-zinc-300">
                          {card.assignee === 'atlas' || card.assignee === 'claude-code' ? <Bot size={11} /> : <User size={11} />}
                          {card.assignee}
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
              {over && target?.beforeId === null && dragId && <div className="h-1 rounded bg-orange-400/70" />}
            </div>
            <footer className="px-2 pb-2">
              {adding === status ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void add(status);
                    if (e.key === 'Escape') setAdding(null);
                  }}
                  onBlur={() => void add(status).then(() => setAdding(null))}
                  placeholder="Card title, Enter to add"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-500"
                />
              ) : (
                <button
                  onClick={() => {
                    setDraft('');
                    setAdding(status);
                  }}
                  className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                >
                  <Plus size={14} /> Add card
                </button>
              )}
            </footer>
          </section>
        );
      })}
    </div>
  );
}
