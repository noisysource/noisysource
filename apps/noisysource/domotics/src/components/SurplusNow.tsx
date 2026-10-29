import { formatWatts } from '../data/energy';

/**
 * Solar going to the grid unpaid because the battery is full or not charging
 * (liveSurplus). Renato doesn't sell to the grid, so this is energy worth using
 * now rather than buying later.
 */
export default function SurplusNow({ surplus }: { surplus: { exportW: number; full: boolean } }) {
  return (
    <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100 leading-relaxed">
      <b className="font-semibold text-amber-200">Excedente solar agora: ~{formatWatts(surplus.exportW)} a ir para a rede</b>, sem
      pagamento — a bateria {surplus.full ? 'está cheia' : 'não está a carregar'}. Boa altura para ligar máquinas ou o forno.
    </div>
  );
}
