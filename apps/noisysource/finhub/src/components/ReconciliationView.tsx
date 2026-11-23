import { apiFetch } from '../lib/api';
import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Link2,
  PlusCircle,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import type {
  InvoiceDocument,
  LedgerTransaction,
  ParsedStatementDraft,
  ReconciliationStatus,
  StatementLine,
} from '../types/finance';
import {
  findDeterministicMatches,
  findMatchingStatementLines,
  formatMoney,
  parseLocalBankCsv,
  readUploadPayload,
} from '../utils/financeMath';

interface ReconciliationViewProps {
  uploadTriggerNonce: number;
}

export function ReconciliationView({ uploadTriggerNonce }: ReconciliationViewProps) {
  const {
    accounts,
    filteredAccounts,
    filteredTransactions,
    filteredStatementBatches,
    filteredStatementLines,
    invoiceDocuments,
    filteredInvoiceDocuments,
    currencyCode,
    importStatementBatch,
    confirmReconciliationMatch,
    createLedgerFromStatementLine,
    attachInvoiceToRecords,
    markLineSuggested,
    flagLineDiscrepancy,
    deleteStatementBatch,
    pushToast,
  } = useTreasury();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ReconciliationStatus>('all');
  const [localCsvOnly, setLocalCsvOnly] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [matching, setMatching] = useState(false);

  // Import Statement Draft Modal
  const [draft, setDraft] = useState<ParsedStatementDraft | null>(null);
  const [draftAccountId, setDraftAccountId] = useState<string>('');
  const [importing, setImporting] = useState(false);

  // Inline create-entry or flag modal
  const [createLine, setCreateLine] = useState<StatementLine | null>(null);
  const [newCategory, setNewCategory] = useState('Bank Fees & Operations');
  const [createHistoricalMode, setCreateHistoricalMode] = useState(false);
  const [createIvaRate, setCreateIvaRate] = useState('0');
  const [createIvaDeductible, setCreateIvaDeductible] = useState(false);
  const [createInvoiceDocId, setCreateInvoiceDocId] = useState('');
  const [flagLine, setFlagLine] = useState<StatementLine | null>(null);
  const [flagNote, setFlagNote] = useState('');
  const [attachingLine, setAttachingLine] = useState<StatementLine | null>(null);

  // Manual match candidate picker per line
  const [manualMatchSelection, setManualMatchSelection] = useState<Record<string, string>>({});

  React.useEffect(() => {
    if (uploadTriggerNonce > 0) {
      fileInputRef.current?.click();
    }
  }, [uploadTriggerNonce]);

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const txMap = useMemo(
    () => new Map(filteredTransactions.map((t) => [t.id, t])),
    [filteredTransactions]
  );

  const visibleLines = useMemo(() => {
    return filteredStatementLines.filter((l) => {
      if (selectedAccountId !== 'all' && l.accountId !== selectedAccountId) return false;
      if (statusFilter !== 'all' && l.reconciliationStatus !== statusFilter) return false;
      return true;
    });
  }, [filteredStatementLines, selectedAccountId, statusFilter]);

  const counts = useMemo(() => {
    const scope =
      selectedAccountId === 'all'
        ? filteredStatementLines
        : filteredStatementLines.filter((l) => l.accountId === selectedAccountId);
    return {
      all: scope.length,
      unmatched: scope.filter((l) => l.reconciliationStatus === 'unmatched').length,
      suggested: scope.filter((l) => l.reconciliationStatus === 'suggested').length,
      reconciled: scope.filter((l) => l.reconciliationStatus === 'reconciled').length,
      discrepancy: scope.filter((l) => l.reconciliationStatus === 'discrepancy').length,
    };
  }, [filteredStatementLines, selectedAccountId]);

  const handleStatementUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setParsing(true);
    try {
      const isCsv = file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv';
      let nextDraft: ParsedStatementDraft;

      if (isCsv && localCsvOnly) {
        const text = await file.text();
        nextDraft = parseLocalBankCsv(text, file.name);
      } else {
        const payload = await readUploadPayload(file);
        const resp = await apiFetch('/api/parse/statement', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = (await resp.json()) as {
          data?: Omit<ParsedStatementDraft, 'filename'>;
          error?: string;
        };
        if (!resp.ok || !json.data) {
          throw new Error(json.error || 'Unable to parse bank statement.');
        }
        nextDraft = {
          filename: file.name,
          statementPeriod: json.data.statementPeriod || 'Imported Statement',
          openingBalance: Number(json.data.openingBalance) || 0,
          closingBalance: Number(json.data.closingBalance) || 0,
          lines: Array.isArray(json.data.lines) ? json.data.lines : [],
        };
      }

      const defaultAcc =
        selectedAccountId !== 'all'
          ? selectedAccountId
          : filteredAccounts[0]?.id || accounts[0]?.id || '';
      setDraftAccountId(defaultAcc);
      setDraft(nextDraft);
    } catch (err) {
      pushToast(
        'Statement parse failed',
        err instanceof Error ? err.message : 'Unable to process file.',
        'error'
      );
    } finally {
      setParsing(false);
    }
  };

  const handleCommitDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const acc = accountMap.get(draftAccountId);
    if (!acc) {
      pushToast('Select an account', 'Choose a target bank account before importing.', 'error');
      return;
    }
    setImporting(true);
    try {
      await importStatementBatch({
        entityId: acc.entityId,
        accountId: acc.id,
        filename: draft.filename,
        statementPeriod: draft.statementPeriod,
        openingBalance: draft.openingBalance,
        closingBalance: draft.closingBalance,
        lines: draft.lines,
      });
      setDraft(null);
    } finally {
      setImporting(false);
    }
  };

  const handleAutoMatch = async () => {
    setMatching(true);
    try {
      const targetLines = visibleLines.filter((l) => l.reconciliationStatus === 'unmatched');
      if (targetLines.length === 0) {
        pushToast('No unmatched lines', 'All visible lines are already matched or flagged.', 'info');
        return;
      }

      const deterministic = findDeterministicMatches(targetLines, filteredTransactions);
      const matchedLineIds = new Set<string>();
      for (const m of deterministic) {
        matchedLineIds.add(m.lineId);
        await markLineSuggested(m.lineId, m.transactionId);
      }

      const remainingLines = targetLines.filter((l) => !matchedLineIds.has(l.id));
      const candidateTxs = filteredTransactions.filter((t) => t.status !== 'reconciled');

      let aiMatchCount = 0;
      if (remainingLines.length > 0 && candidateTxs.length > 0) {
        const resp = await apiFetch('/api/reconcile/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            statementLines: remainingLines.map((l) => ({
              id: l.id,
              date: l.date,
              description: l.description,
              amount: l.amount,
              direction: l.direction,
            })),
            transactions: candidateTxs.map((t) => ({
              id: t.id,
              date: t.date,
              description: t.description,
              amount: t.amount,
              type: t.type,
              category: t.category,
            })),
          }),
        });
        if (resp.ok) {
          const json = (await resp.json()) as {
            matches?: Array<{ lineId: string; transactionId: string; confidence: number }>;
          };
          for (const m of json.matches ?? []) {
            if (
              m.confidence >= 0.7 &&
              remainingLines.some((l) => l.id === m.lineId) &&
              candidateTxs.some((t) => t.id === m.transactionId)
            ) {
              await markLineSuggested(m.lineId, m.transactionId);
              aiMatchCount++;
            }
          }
        }
      }

      const totalFound = deterministic.length + aiMatchCount;
      pushToast(
        'Auto-match complete',
        totalFound > 0
          ? `Proposed ${totalFound} matches for your confirmation.`
          : 'No additional matching ledger entries found.',
        totalFound > 0 ? 'success' : 'info'
      );
    } catch (err) {
      pushToast(
        'Auto-match error',
        err instanceof Error ? err.message : 'Unable to run matching.',
        'error'
      );
    } finally {
      setMatching(false);
    }
  };

  return (
    <div className="space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.txt"
        onChange={handleStatementUpload}
        className="hidden"
      />

      {/* Toolbar */}
      <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label htmlFor="recon-account-filter" className="sr-only">
              Bank Account Filter
            </label>
            <select
              id="recon-account-filter"
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-medium text-slate-100"
            >
              <option value="all">All Accounts ({filteredAccounts.length})</option>
              {filteredAccounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} · {acc.institution}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-1 p-1 bg-[#1E293B] border border-slate-700 rounded-lg">
            {(
              [
                ['all', `All (${counts.all})`],
                ['unmatched', `Unmatched (${counts.unmatched})`],
                ['suggested', `Suggested (${counts.suggested})`],
                ['reconciled', `Reconciled (${counts.reconciled})`],
                ['discrepancy', `Discrepancies (${counts.discrepancy})`],
              ] as Array<['all' | ReconciliationStatus, string]>
            ).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setStatusFilter(val)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  statusFilter === val
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={localCsvOnly}
              onChange={(e) => setLocalCsvOnly(e.target.checked)}
              className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
            />
            <span>Local CSV (Zero AI)</span>
          </label>
          <button
            onClick={handleAutoMatch}
            disabled={matching}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg whitespace-nowrap cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-blue-400" />
            <span>{matching ? 'Matching...' : 'Auto-Match Suggestions'}</span>
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={parsing}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg whitespace-nowrap cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{parsing ? 'Parsing Statement...' : 'Upload Statement'}</span>
          </button>
        </div>
      </div>

      {/* Imported Batches Summary */}
      {filteredStatementBatches.length > 0 && (
        <section className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-100 mb-3">Imported Bank Statement Batches</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredStatementBatches.map((b) => {
              const acc = accountMap.get(b.accountId);
              return (
                <div
                  key={b.id}
                  className="p-3.5 bg-[#1E293B]/50 border border-slate-800 rounded-lg flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-100 truncate">{b.filename}</p>
                    <p className="text-xs text-slate-400 mt-0.5 truncate">
                      {acc?.name ?? 'Account'} · {b.statementPeriod}
                    </p>
                    <p className="text-xs font-mono tabular-nums text-slate-300 mt-1.5">
                      {b.lineCount} lines · Close {formatMoney(b.closingBalance, currencyCode)}
                    </p>
                  </div>
                  <button
                    onClick={() => void deleteStatementBatch(b.id)}
                    title="Delete non-reconciled batch"
                    aria-label={`Delete batch ${b.filename}`}
                    className="text-slate-500 hover:text-rose-400 p-1 shrink-0 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Statement Lines Reconciliation Workbench */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-slate-100">Statement Reconciliation Workbench</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Match bank lines against recorded ledger entries, create missing ledger transactions, or flag discrepancies
          </p>
        </div>

        {visibleLines.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm text-slate-300">No bank statement lines match the current filter.</p>
            <p className="text-xs text-slate-500">
              Upload a PDF, image, or CSV bank statement to start reconciling transactions.
            </p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Upload Statement</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">Date &amp; Bank Description</th>
                  <th className="py-3 px-4 font-medium">Account</th>
                  <th className="py-3 px-4 font-medium text-right">Amount</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium">Ledger Candidate</th>
                  <th className="py-3 px-4 font-medium">Invoice / Drive PDF</th>
                  <th className="py-3 px-6 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {visibleLines.map((line) => {
                  const acc = accountMap.get(line.accountId);
                  const chosenTxId =
                    manualMatchSelection[line.id] ?? line.matchedTransactionId ?? '';
                  const matchedTx = chosenTxId ? txMap.get(chosenTxId) : undefined;
                  const linkedInvoice = invoiceDocuments.find(
                    (d) =>
                      d.statementLineId === line.id ||
                      (matchedTx && (d.id === matchedTx.invoiceDocId || d.transactionId === matchedTx.id))
                  );
                  const driveUrl = linkedInvoice?.driveWebViewLink || matchedTx?.driveWebViewLink || '';
                  const driveFolder = linkedInvoice?.driveFolderPath || matchedTx?.driveFolderPath || '';
                  const invoiceRef = linkedInvoice?.invoiceNumber || matchedTx?.invoiceNumber || '';
                  const candidatePool = filteredTransactions.filter(
                    (t) =>
                      t.accountId === line.accountId &&
                      t.status !== 'reconciled' &&
                      (line.direction === 'credit' ? t.type === 'income' : t.type !== 'income')
                  );

                  return (
                    <tr key={line.id} className="hover:bg-slate-800/30">
                      <td className="py-3.5 px-6">
                        <p className="font-medium text-slate-100">{line.description}</p>
                        <p className="text-xs font-mono tabular-nums text-slate-400 mt-0.5">
                          {line.date} · {line.direction === 'credit' ? 'Credit' : 'Debit'}
                        </p>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-300">
                        {acc?.name ?? 'Account'}
                      </td>
                      <td
                        className={`py-3.5 px-4 text-right font-mono tabular-nums font-medium ${
                          line.direction === 'credit' ? 'text-emerald-400' : 'text-slate-100'
                        }`}
                      >
                        {line.direction === 'credit' ? '+' : '-'}
                        {formatMoney(line.amount, currencyCode)}
                      </td>
                      <td className="py-3.5 px-4 text-xs whitespace-nowrap">
                        {line.reconciliationStatus === 'reconciled' ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Reconciled
                          </span>
                        ) : line.reconciliationStatus === 'suggested' ? (
                          <span className="inline-flex items-center gap-1 text-blue-400">
                            <Sparkles className="w-3.5 h-3.5" />
                            Suggested Match
                          </span>
                        ) : line.reconciliationStatus === 'discrepancy' ? (
                          <span className="inline-flex items-center gap-1 text-rose-400">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            Discrepancy
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-300">
                            <Clock className="w-3.5 h-3.5" />
                            Unmatched
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 min-w-[200px]">
                        {line.reconciliationStatus === 'reconciled' ? (
                          <p className="text-xs text-slate-300 truncate max-w-[220px]">
                            {matchedTx ? `${matchedTx.date} · ${matchedTx.description}` : 'Linked to ledger'}
                          </p>
                        ) : line.reconciliationStatus === 'discrepancy' ? (
                          <p className="text-xs text-rose-300 truncate max-w-[220px]">
                            {line.discrepancyNote || 'Flagged for review'}
                          </p>
                        ) : (
                          <select
                            value={chosenTxId}
                            onChange={(e) =>
                              setManualMatchSelection((prev) => ({
                                ...prev,
                                [line.id]: e.target.value,
                              }))
                            }
                            className="w-full max-w-[220px] bg-[#1E293B] border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200"
                          >
                            <option value="">Select ledger match...</option>
                            {candidatePool.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.date} · {t.description} ({formatMoney(t.amount, currencyCode)})
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-xs min-w-[180px]">
                        {driveUrl ? (
                          <div className="space-y-0.5">
                            {driveFolder && (
                              <p className="font-mono text-[11px] text-slate-400 truncate max-w-[190px]">
                                {driveFolder}
                              </p>
                            )}
                            <a
                              href={driveUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 font-medium"
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span>{invoiceRef || 'Open Invoice PDF'}</span>
                            </a>
                          </div>
                        ) : linkedInvoice ? (
                          <span className="text-emerald-400 font-mono">
                            {linkedInvoice.invoiceNumber || linkedInvoice.filename}
                          </span>
                        ) : (
                          <button
                            onClick={() => setAttachingLine(line)}
                            className="inline-flex items-center gap-1 text-slate-400 hover:text-sky-400 cursor-pointer"
                          >
                            <FileText className="w-3 h-3" />
                            <span>Attach Invoice</span>
                          </button>
                        )}
                      </td>
                      <td className="py-3.5 px-6 text-right whitespace-nowrap">
                        {line.reconciliationStatus === 'reconciled' ? (
                          <div className="inline-flex items-center gap-2">
                            {!linkedInvoice && (
                              <button
                                onClick={() => setAttachingLine(line)}
                                className="text-xs text-sky-400 hover:text-sky-300 cursor-pointer"
                              >
                                Link PDF
                              </button>
                            )}
                            <span className="text-xs text-slate-500">Locked</span>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-2">
                            {matchedTx && (
                              <button
                                onClick={() => void confirmReconciliationMatch(line, matchedTx, linkedInvoice)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-600/90 hover:bg-emerald-500 text-white text-xs font-medium rounded cursor-pointer"
                              >
                                <Link2 className="w-3 h-3" />
                                Confirm
                              </button>
                            )}
                            <button
                              onClick={() => {
                                setCreateLine(line);
                                setNewCategory(
                                  line.direction === 'credit' ? 'Operating Revenue' : 'Bank & Operations'
                                );
                                setCreateHistoricalMode(line.date.startsWith('2025-'));
                                setCreateIvaRate('0');
                                setCreateIvaDeductible(false);
                                setCreateInvoiceDocId('');
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium rounded cursor-pointer"
                            >
                              <PlusCircle className="w-3 h-3" />
                              Create Entry
                            </button>
                            {line.reconciliationStatus !== 'discrepancy' && (
                              <button
                                onClick={() => {
                                  setFlagLine(line);
                                  setFlagNote('');
                                }}
                                className="text-xs text-rose-400 hover:text-rose-300 px-1.5 cursor-pointer"
                              >
                                Flag
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Statement Import Review Modal */}
      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setDraft(null)} />
          <form
            onSubmit={handleCommitDraft}
            className="relative z-10 max-w-3xl w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] flex flex-col"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 shrink-0">
              <div>
                <h3 className="text-base font-semibold text-slate-100">Confirm Extracted Bank Statement</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {draft.filename} · {draft.lines.length} transactions extracted
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 shrink-0">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Target Bank Account</label>
                <select
                  required
                  value={draftAccountId}
                  onChange={(e) => setDraftAccountId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.institution})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Statement Period</label>
                <input
                  type="text"
                  required
                  value={draft.statementPeriod}
                  onChange={(e) => setDraft({ ...draft, statementPeriod: e.target.value })}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Closing Balance</label>
                <input
                  type="number"
                  step="0.01"
                  value={draft.closingBalance}
                  onChange={(e) =>
                    setDraft({ ...draft, closingBalance: Number(e.target.value) || 0 })
                  }
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto border border-slate-800 rounded-lg">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 bg-[#111827] border-b border-slate-800 text-slate-400">
                  <tr>
                    <th className="py-2.5 px-3 font-medium">Date</th>
                    <th className="py-2.5 px-3 font-medium">Description</th>
                    <th className="py-2.5 px-3 font-medium">Direction</th>
                    <th className="py-2.5 px-3 font-medium text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {draft.lines.map((l, idx) => (
                    <tr key={idx}>
                      <td className="py-2 px-3 font-mono tabular-nums text-slate-300">{l.date}</td>
                      <td className="py-2 px-3 text-slate-100">{l.description}</td>
                      <td className="py-2 px-3 text-slate-400">{l.direction}</td>
                      <td
                        className={`py-2 px-3 text-right font-mono tabular-nums ${
                          l.direction === 'credit' ? 'text-emerald-400' : 'text-slate-200'
                        }`}
                      >
                        {formatMoney(l.amount, currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pt-2 border-t border-slate-800 flex justify-end gap-3 shrink-0">
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="px-4 py-2 bg-[#1E293B] hover:bg-slate-700 text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={importing || draft.lines.length === 0}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {importing ? 'Importing...' : `Import ${draft.lines.length} Lines`}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Create Ledger Entry from Unmatched Line Modal */}
      {createLine && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setCreateLine(null)} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const txType: LedgerTransaction['type'] =
                createLine.direction === 'credit' ? 'income' : 'expense';
              const invDoc = createInvoiceDocId
                ? invoiceDocuments.find((d) => d.id === createInvoiceDocId)
                : undefined;
              await createLedgerFromStatementLine(createLine, newCategory, txType, {
                adjustAccountBalance: !createHistoricalMode,
                ivaRate: Number(createIvaRate) || 0,
                ivaDeductible: createIvaDeductible,
                invoiceDoc: invDoc,
              });
              setCreateLine(null);
            }}
            className="relative z-10 max-w-md w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4"
          >
            <h3 className="text-base font-semibold text-slate-100">Create Ledger Entry &amp; Reconcile</h3>
            <p className="text-xs text-slate-400">
              {createLine.date} · {createLine.description} ·{' '}
              <span className="font-mono text-slate-100">
                {formatMoney(createLine.amount, currencyCode)}
              </span>
            </p>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Ledger Category</label>
              <input
                type="text"
                required
                maxLength={60}
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">IVA Rate (%)</label>
                <select
                  value={createIvaRate}
                  onChange={(e) => setCreateIvaRate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                >
                  <option value="0">0% (Exempt)</option>
                  <option value="6">6%</option>
                  <option value="13">13%</option>
                  <option value="23">23%</option>
                </select>
              </div>
              <div className="pt-5">
                <label className="flex items-center gap-2 text-xs text-emerald-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createIvaDeductible}
                    onChange={(e) => setCreateIvaDeductible(e.target.checked)}
                    className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                  />
                  <span>IVA Dedutível</span>
                </label>
              </div>
            </div>

            {filteredInvoiceDocuments.length > 0 && (
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Link Invoice PDF from Vault (Optional)
                </label>
                <select
                  value={createInvoiceDocId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setCreateInvoiceDocId(id);
                    const found = invoiceDocuments.find((d) => d.id === id);
                    if (found) {
                      setCreateIvaRate(String(found.ivaRate));
                      setCreateIvaDeductible(found.ivaDeductible);
                    }
                  }}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                >
                  <option value="">No linked invoice PDF</option>
                  {filteredInvoiceDocuments
                    .filter((d) => d.status !== 'reconciled')
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.date} · {d.vendor} ({formatMoney(d.amount, currencyCode)})
                      </option>
                    ))}
                </select>
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={createHistoricalMode}
                onChange={(e) => setCreateHistoricalMode(e.target.checked)}
                className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
              />
              <span>Historical entry — preserve current live account balance</span>
            </label>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setCreateLine(null)}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                Create &amp; Reconcile
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Flag Discrepancy Modal */}
      {flagLine && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setFlagLine(null)} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await flagLineDiscrepancy(flagLine.id, flagNote);
              setFlagLine(null);
            }}
            className="relative z-10 max-w-md w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4"
          >
            <h3 className="text-base font-semibold text-slate-100">Flag Statement Discrepancy</h3>
            <p className="text-xs text-slate-400">{flagLine.description}</p>
            <div>
              <label className="block text-xs text-slate-300 mb-1">Reason / Audit Note</label>
              <input
                type="text"
                required
                maxLength={200}
                placeholder="e.g. Duplicate merchant charge, awaiting dispute"
                value={flagNote}
                onChange={(e) => setFlagNote(e.target.value)}
                className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
              />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setFlagLine(null)}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                Flag Line
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Attach Invoice PDF to Statement Line Modal */}
      {attachingLine && (
        <AttachInvoiceModal
          line={attachingLine}
          invoiceDocuments={filteredInvoiceDocuments}
          currencyCode={currencyCode}
          onClose={() => setAttachingLine(null)}
          onAttach={async (docItem) => {
            await attachInvoiceToRecords({
              invoiceDoc: docItem,
              statementLineId: attachingLine.id,
              transactionId: attachingLine.matchedTransactionId || docItem.transactionId,
            });
            setAttachingLine(null);
          }}
        />
      )}
    </div>
  );
}

function AttachInvoiceModal({
  line,
  invoiceDocuments,
  currencyCode,
  onClose,
  onAttach,
}: {
  line: StatementLine;
  invoiceDocuments: InvoiceDocument[];
  currencyCode: 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD' | 'CHF' | 'JPY' | 'PLN' | 'SEK' | 'NOK';
  onClose: () => void;
  onAttach: (doc: InvoiceDocument) => Promise<void>;
}) {
  const ranked = useMemo(() => {
    const scored = invoiceDocuments.map((docItem) => {
      const m = findMatchingStatementLines(
        { date: docItem.date, amount: docItem.amount, vendor: docItem.vendor, entityId: docItem.entityId },
        [line]
      );
      return { docItem, score: m[0]?.score ?? 0 };
    });
    return scored.sort((a, b) => b.score - a.score);
  }, [invoiceDocuments, line]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/75" onClick={onClose} />
      <div className="relative z-10 max-w-xl w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3 shrink-0">
          <div>
            <h3 className="text-base font-semibold text-slate-100">Attach Invoice PDF</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {line.date} · {line.description} ·{' '}
              <span className="font-mono text-slate-200">{formatMoney(line.amount, currencyCode)}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/80 border border-slate-800 rounded-lg">
          {ranked.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400">
              No invoice documents in your vault yet. Scan Gmail or upload invoices in the Gmail &amp; Drive hub first.
            </div>
          ) : (
            ranked.map(({ docItem, score }) => (
              <div
                key={docItem.id}
                className="p-3.5 flex items-center justify-between gap-4 hover:bg-slate-800/35"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-400">{docItem.date}</span>
                    <span className="text-xs font-medium text-slate-100 truncate">
                      {docItem.vendor} · {docItem.invoiceNumber || docItem.filename}
                    </span>
                    {score > 0 && (
                      <span className="text-[11px] font-mono text-emerald-400">
                        {Math.round(score * 100)}%
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] font-mono text-slate-400 truncate mt-0.5">
                    {docItem.driveFolderPath || 'Vault Document'}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs font-mono tabular-nums text-slate-100">
                    {formatMoney(docItem.amount, currencyCode)}
                  </span>
                  <button
                    onClick={() => void onAttach(docItem)}
                    className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded cursor-pointer"
                  >
                    Attach
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
