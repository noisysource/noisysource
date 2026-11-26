import { ChevronRight, ClipboardList, LogIn, LogOut, Map as MapIcon, Pencil, Server } from 'lucide-react';
import type { User } from 'firebase/auth';

interface Props {
  user: User | null;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onOpenPlan2D: () => void;
  onStartEdit: () => void;
  onOpenReports: () => void;
  onOpenAdmin: () => void;
}

/** What isn't used every day: the 2D plan and its editor, reports, the bridge, the session. */
export default function MaisScreen({ user, onSignIn, onSignOut, onOpenPlan2D, onStartEdit, onOpenReports, onOpenAdmin }: Props) {
  const row = 'w-full min-h-[56px] px-4 flex items-center gap-3 text-left text-[15px] text-zinc-100 hover:bg-zinc-800/60 transition-colors';
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 pb-6 flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-zinc-50" style={{ paddingTop: 'env(safe-area-inset-top)' }}>Mais</h1>
      <div className="rounded-2xl bg-zinc-900 border border-zinc-800 divide-y divide-zinc-800 overflow-hidden">
        <button onClick={onOpenPlan2D} className={row}><MapIcon size={18} className="text-zinc-400" /><span className="flex-1">Planta 2D</span><ChevronRight size={16} className="text-zinc-500" /></button>
        <button onClick={onStartEdit} className={row}><Pencil size={18} className="text-zinc-400" /><span className="flex-1">Editar a planta e os dispositivos</span><ChevronRight size={16} className="text-zinc-500" /></button>
        {user && <button onClick={onOpenReports} className={row}><ClipboardList size={18} className="text-zinc-400" /><span className="flex-1">Relatórios da bomba</span><ChevronRight size={16} className="text-zinc-500" /></button>}
        {user && <button onClick={onOpenAdmin} className={row}><Server size={18} className="text-zinc-400" /><span className="flex-1">Estado da ponte</span><ChevronRight size={16} className="text-zinc-500" /></button>}
      </div>
      <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden">
        {user ? (
          <button onClick={() => void onSignOut()} className={row}><LogOut size={18} className="text-zinc-400" /><span className="flex-1">Terminar sessão <span className="text-zinc-400">({user.email})</span></span></button>
        ) : (
          <button onClick={() => void onSignIn()} className={row}><LogIn size={18} className="text-zinc-400" /><span className="flex-1">Entrar (para usar fora de casa)</span></button>
        )}
      </div>
    </div>
  );
}
