import { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import { Github, LayoutGrid, LogIn, LogOut, Map as MapIcon, Plus, Search, X } from 'lucide-react';
import { ASSIGNEES, SYSTEMS_BOARD_ID, isOnRoadmap, type Card } from '@shared/lib/kanban';
import { describeSignInError, signIn, signOutUser, watchAuth } from './lib/auth';
import { OWNER_EMAIL, PROJECT_ID } from './lib/firebase';
import { createBoard, useBoards, useCards } from './lib/data';
import { BoardView, type Filters } from './components/BoardView';
import { CardDialog } from './components/CardDialog';
import { GithubSettings } from './components/GithubSettings';

const COLORS = ['#f472b6', '#34d399', '#fbbf24', '#818cf8', '#38bdf8', '#fb923c', '#f87171', '#a3e635'];

function SignIn({ user }: { user: User | null }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900">
          <LayoutGrid size={24} className="text-zinc-400" />
        </div>
        <h1 className="text-xl font-medium">Tasks</h1>
        <p className="mt-2 text-sm text-zinc-500">
          {user ? `${user.email} can't open these boards. Sign in as ${OWNER_EMAIL}.` : 'The Noisy Source boards. Sign in to continue.'}
        </p>
        <button
          onClick={() => (user ? signOutUser() : signIn()).catch((e) => setError(describeSignInError(e)))}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-100 px-4 py-2.5 text-sm font-medium text-zinc-900 hover:bg-white"
        >
          {user ? <LogOut size={16} /> : <LogIn size={16} />} {user ? 'Sign out' : 'Sign in with Google'}
        </button>
        {error && <p className="mt-4 text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}

function Boards() {
  const boards = useBoards();
  const cards = useCards();
  const [boardId, setBoardId] = useState(() => window.location.hash.replace(/^#\/?/, '') || SYSTEMS_BOARD_ID);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ text: '', assignee: '', apps: [] });
  const [error, setError] = useState<string | null>(null);
  const [newBoard, setNewBoard] = useState<string | null>(null);
  const [showGithub, setShowGithub] = useState(false);

  useEffect(() => {
    window.location.hash = `/${boardId}`;
    setFilters((f) => ({ ...f, apps: [] }));
  }, [boardId]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards ?? []) {
      if (c.status === 'done') continue;
      m.set(c.boardId, (m.get(c.boardId) ?? 0) + 1);
      if (isOnRoadmap(c) && c.boardId !== SYSTEMS_BOARD_ID) m.set(SYSTEMS_BOARD_ID, (m.get(SYSTEMS_BOARD_ID) ?? 0) + 1);
    }
    return m;
  }, [cards]);

  if (!boards || !cards) return <div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading boards…</div>;
  const board = boards.find((b) => b.id === boardId) ?? boards[0];
  const open: Card | undefined = cards.find((c) => c.id === openId);
  const isRoadmap = board.id === SYSTEMS_BOARD_ID;

  async function addBoard() {
    const name = (newBoard ?? '').trim();
    if (!name) return setNewBoard(null);
    try {
      const id = await createBoard(name, COLORS[boards!.length % COLORS.length], boards!);
      setNewBoard(null);
      setBoardId(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex h-full">
      <nav className="hidden w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 p-3 md:flex">
        <div className="mb-4 flex items-center gap-2 px-2 pt-1 text-sm font-semibold">
          <LayoutGrid size={16} className="text-orange-400" /> Tasks
          {PROJECT_ID.endsWith('-dev') && <span className="rounded bg-amber-500/20 px-1.5 text-[10px] text-amber-300">DEV</span>}
        </div>
        {boards.map((b) => (
          <button
            key={b.id}
            onClick={() => setBoardId(b.id)}
            className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
              b.id === board.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
            } ${b.id === SYSTEMS_BOARD_ID ? 'mb-2' : ''}`}
          >
            {b.id === SYSTEMS_BOARD_ID
              ? <MapIcon size={14} />
              : <span className="h-2.5 w-2.5 rounded-sm" style={{ background: b.color }} />}
            <span className="flex-1 truncate">{b.name}</span>
            <span className="text-xs text-zinc-600">{counts.get(b.id) ?? ''}</span>
          </button>
        ))}
        {newBoard === null ? (
          <button onClick={() => setNewBoard('')} className="mt-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-500 hover:text-zinc-300">
            <Plus size={14} /> New board
          </button>
        ) : (
          <input autoFocus value={newBoard} onChange={(e) => setNewBoard(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addBoard(); if (e.key === 'Escape') setNewBoard(null); }}
            onBlur={() => void addBoard()} placeholder="App name"
            className="mt-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm outline-none" />
        )}
        <button onClick={() => setShowGithub(true)} className="mt-auto flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-300">
          <Github size={13} /> GitHub
        </button>
        <button onClick={() => void signOutUser()} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-300">
          <LogOut size={13} /> Sign out
        </button>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col p-4">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <select value={board.id} onChange={(e) => setBoardId(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm md:hidden">
            {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <div className="hidden md:block">
            <h1 className="text-lg font-medium">{board.name}</h1>
            <p className="text-xs text-zinc-500">
              {isRoadmap ? 'Cross-app work, plus every card marked "roadmap" on an app board.' : board.path ?? ''}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2">
              <Search size={13} className="text-zinc-500" />
              <input value={filters.text} onChange={(e) => setFilters({ ...filters, text: e.target.value })}
                placeholder="Filter" className="w-36 bg-transparent py-1.5 text-sm outline-none" />
            </div>
            <select value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm">
              <option value="">Anyone</option>
              <option value="none">Unassigned</option>
              {ASSIGNEES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          {isRoadmap && (
            <div className="flex w-full flex-wrap gap-1.5">
              {boards.map((b) => {
                const on = filters.apps.includes(b.id);
                return (
                  <button key={b.id}
                    onClick={() => setFilters({ ...filters, apps: on ? filters.apps.filter((x) => x !== b.id) : [...filters.apps, b.id] })}
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? 'border-zinc-500 text-white' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
                    style={on ? { background: `${b.color}22` } : undefined}
                  >
                    {b.id === SYSTEMS_BOARD_ID ? 'Cross-app' : b.name}
                  </button>
                );
              })}
            </div>
          )}
        </header>
        <div className="min-h-0 flex-1">
          <BoardView board={board} boards={boards} cards={cards} filters={filters} onOpen={(c) => setOpenId(c.id)} onError={setError} />
        </div>
      </main>

      {showGithub && <GithubSettings onClose={() => setShowGithub(false)} />}
      {open && <CardDialog key={open.id} card={open} boards={boards} onClose={() => setOpenId(null)} onError={setError} />}
      {error && (
        <div className="fixed bottom-4 right-4 z-30 flex max-w-md items-start gap-2 rounded-xl border border-red-500/30 bg-zinc-900 px-4 py-3 text-sm text-red-300 shadow-xl">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => watchAuth(setUser), []);
  if (user === undefined) return null;
  const isOwner = user?.email === OWNER_EMAIL && user.emailVerified;
  return isOwner ? <Boards /> : <SignIn user={user} />;
}
