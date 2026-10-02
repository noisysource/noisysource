import { useState } from 'react';
import { callable } from '../../lib/callable';

/**
 * Manual repair tools for billing and occurrences. Neither is part of the
 * normal flow — subscription, absence and status changes already recompute
 * billing and regenerate occurrences on their own — so they live here rather
 * than on the billing page, where they invited being clicked.
 */
export default function MaintenancePanel() {
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [generatingEvents, setGeneratingEvents] = useState(false);
  const [generateEventsResult, setGenerateEventsResult] = useState<string | null>(null);

  // Forces backfillBillingSchedules for every family at once. Needed after a
  // price/discount-rule change or a billing fix that should apply to bills
  // already generated; individual changes are recomputed by the triggers
  // (onStudyroomBillingSync / onTransportBillingSync / onReservationEventBillingSync).
  const handleBackfill = async () => {
    if (!confirm('Forçar recálculo de faturação para TODAS as famílias com inscrições ativas? Normalmente não é necessário — use apenas para uma correção geral.')) return;
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const fn = callable<object, { created: number; updated: number; skipped: number; cancelled: number; failed: number; families: number }>('backfillBillingSchedules');
      const res = await fn({});
      const { created, updated, skipped, cancelled, families } = res.data;
      const parts = [`${families} famílias`, `${created} criados`, `${updated} atualizados`, `${skipped} ignorados`];
      if (cancelled) parts.push(`${cancelled} cancelados`);
      setBackfillResult(`✅ ${parts.join(' · ')}`);
    } catch (err: any) {
      setBackfillResult(`❌ ${err.message}`);
    } finally {
      setBackfilling(false);
    }
  };

  // Regenerates ReservationEvents for every active subscription. Repair-only
  // now: events are regenerated automatically on every subscription write.
  // Safe to re-run — event ids are deterministic, so a rerun overwrites
  // rather than duplicating, and marked absences are never changed.
  const handleGenerateEvents = async () => {
    if (!confirm(
      'Gerar ocorrências (ReservationEvents) para todas as inscrições ativas?\n\n'
      + 'Normalmente não é necessário — as ocorrências são geradas automaticamente sempre que '
      + 'uma inscrição é alterada. Pode ser repetido em segurança: só cria o que falta.'
    )) return;
    setGeneratingEvents(true);
    setGenerateEventsResult(null);
    try {
      const fn = callable<object, { studySubscriptions: number; transportSubscriptions: number; created: number }>('backfillReservationEvents');
      const res = await fn({});
      const { studySubscriptions, transportSubscriptions, created } = res.data;
      setGenerateEventsResult(`✅ ${studySubscriptions} inscrições de sala de estudo · ${transportSubscriptions} de transporte · ${created} ocorrência(s) criada(s)`);
    } catch (err: any) {
      setGenerateEventsResult(`❌ ${err.message}`);
    } finally {
      setGeneratingEvents(false);
    }
  };

  return (
    <div className="mb-10 space-y-3">
      <div>
        <h2 className="text-lg font-bold text-gray-800">Manutenção</h2>
        <p className="text-sm text-gray-500">Ferramentas de reparação. Não fazem parte do funcionamento normal.</p>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-700">🛠️ Recalcular faturação de todas as famílias</p>
          <p className="text-xs text-gray-500">
            Alterações a inscrições ou faltas já recalculam a faturação automaticamente. Use isto depois
            de mudar preços ou regras de desconto, ou depois de uma correção à faturação que deva aplicar-se
            às faturas já geradas. Faturas pagas/faturadas não são alteradas.
          </p>
        </div>
        <button onClick={handleBackfill} disabled={backfilling}
          className="px-4 py-2 bg-gray-600 text-white text-sm font-medium rounded hover:bg-gray-700 disabled:opacity-50 shrink-0">
          {backfilling ? 'A recalcular...' : '🛠️ Recalcular tudo'}
        </button>
        {backfillResult && <span className="text-sm text-gray-700 w-full">{backfillResult}</span>}
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-700">📅 Gerar ocorrências das inscrições</p>
          <p className="text-xs text-gray-500">
            Só para reparação: as ocorrências são geradas automaticamente sempre que uma inscrição é
            criada ou alterada. Use isto se uma inscrição aparecer sem ocorrências no calendário.
            Repetível em segurança — só cria o que falta, nunca altera faltas já marcadas.
          </p>
        </div>
        <button onClick={handleGenerateEvents} disabled={generatingEvents}
          className="px-4 py-2 bg-gray-600 text-white text-sm font-medium rounded hover:bg-gray-700 disabled:opacity-50 shrink-0">
          {generatingEvents ? 'A gerar...' : '📅 Gerar ocorrências'}
        </button>
        {generateEventsResult && <span className="text-sm text-gray-700 w-full">{generateEventsResult}</span>}
      </div>
    </div>
  );
}
