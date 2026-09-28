import { SubStatus } from '../../../lib/utils';
import { LastClientAction } from './model';

export const WEEKDAYS = [
  { value: 'monday', label: 'Segunda' },
  { value: 'tuesday', label: 'Terça' },
  { value: 'wednesday', label: 'Quarta' },
  { value: 'thursday', label: 'Quinta' },
  { value: 'friday', label: 'Sexta' },
];
export const DAY_PT: Record<string, string> = {
  monday: 'Seg', tuesday: 'Ter', wednesday: 'Qua',
  thursday: 'Qui', friday: 'Sex', saturday: 'Sáb', sunday: 'Dom',
};
// ─── Badges ───────────────────────────────────────────────────────────────────
export const StatusBadge = ({ status, cancelRequested }: { status: SubStatus; cancelRequested?: boolean }) => {
  if (cancelRequested && status === 'active')
    return <span className="text-xs bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full font-medium">Cancelamento pedido</span>;
  const map: Record<SubStatus, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    active: 'bg-green-100 text-green-800',
    cancelled: 'bg-gray-100 text-gray-600',
  };
  const label: Record<SubStatus, string> = {
    pending: 'Pendente', active: 'Ativa', cancelled: 'Cancelada',
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[status]}`}>{label[status]}</span>;
};

// What the admin should do next for each kind of client-initiated change —
// one generic "review needed" badge doesn't say whether it's ready to
// activate, needs a call about a cancellation, or is just an FYI.
export const CLIENT_ACTION_BADGE: Record<LastClientAction, { label: string; cls: string }> = {
  confirmed: { label: '✅ Confirmado — ativar', cls: 'bg-green-100 text-green-800 hover:bg-green-200' },
  cancelRequested: { label: '🚫 Pedido de cancelamento', cls: 'bg-red-100 text-red-800 hover:bg-red-200' },
  edited: { label: '✏️ Encarregado editou o pedido', cls: 'bg-blue-100 text-blue-800 hover:bg-blue-200' },
  rejected: { label: '⚠️ Encarregado recusou a alteração', cls: 'bg-amber-100 text-amber-800 hover:bg-amber-200' },
};
