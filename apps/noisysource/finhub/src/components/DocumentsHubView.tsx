import { apiFetch, type ApiResponse } from '../lib/api';
import { countsOf, decideAtlasImport, entityForHint, watchPendingAtlasImports, type AtlasImport } from '../lib/atlasImports';
import React, { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderInput,
  History,
  Link2,
  Lock,
  Mail,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTreasury } from '../contexts/TreasuryContext';
import type {
  DriveFileItem,
  DriveFolderItem,
  GmailCandidateMessage,
  InvoiceDocument,
  ParsedInvoiceDraft,
  ParsedPayslipDraft,
  ParsedStatementDraft,
  StatementLine,
  SuggestedContractDraft,
  SuggestedFacilityDraft,
  SuggestedStatementTransactionDraft,
  SuggestedSubscriptionDraft,
  TransactionType,
} from '../types/finance';
import {
  computeTransactionIva,
  findMatchingStatementLines,
  formatMoney,
  parseLocalBankCsv,
  readUploadPayload,
  todayIsoDate,
} from '../utils/financeMath';

interface DocumentsHubViewProps {
  initialTabNonce?: number;
}

type HubTab = 'atlas' | 'gmail' | 'drive' | 'historical' | 'vault';

interface PendingInvoiceReview {
  source: 'gmail' | 'drive' | 'upload';
  gmailMessageId: string;
  existingDriveFileId: string;
  existingDriveWebViewLink: string;
  mimeType: string;
  base64Data: string;
  filename: string;
  vendor: string;
  vendorNif: string;
  invoiceNumber: string;
  date: string;
  amount: number;
  ivaRate: number;
  ivaAmount: number;
  ivaDeductible: boolean;
  category: string;
  description: string;
  entityId: string;
  accountId: string;
  isCrossEntityReimb: boolean;
  paidByEntityId: string;
  matchedStatementLineId: string;
  historicalPreserveBalance: boolean;
  notes: string;
}

interface DriveConfirmState {
  mode: 'single' | 'batch';
  items: PendingInvoiceReview[];
  rootFolderId: string;
  rootFolderName: string;
  docCategory: string;
}

export function DocumentsHubView({ initialTabNonce }: DocumentsHubViewProps) {
  const { workspaceToken, hasWorkspaceAccess, connectingWorkspace, connectGoogleWorkspace, clearWorkspaceToken } =
    useAuth();
  const {
    entities,
    accounts,
    statementLines,
    filteredStatementLines,
    filteredInvoiceDocuments,
    currencyCode,
    createLedgerAndFileInvoice,
    addInvoiceDocument,
    attachInvoiceToRecords,
    deleteInvoiceDocument,
    importStatementBatch,
    importDriveGeneratedBundle,
    addPayslip,
    pushToast,
  } = useTreasury();

  // Document reading is Atlas's (STATUS.md): what it imported comes first.
  const [activeTab, setActiveTab] = useState<HubTab>('atlas');
  const [atlasImports, setAtlasImports] = useState<AtlasImport[]>([]);
  const [atlasImportsError, setAtlasImportsError] = useState('');
  // The import open in the workbench: marked applied once he commits it there.
  const [loadedAtlasImport, setLoadedAtlasImport] = useState<AtlasImport | null>(null);
  const [decidingAtlasImport, setDecidingAtlasImport] = useState('');

  React.useEffect(
    () =>
      watchPendingAtlasImports(
        (imports) => {
          setAtlasImports(imports);
          setAtlasImportsError('');
        },
        (err) => setAtlasImportsError(err.message)
      ),
    []
  );
  const [showPrivacyPanel, setShowPrivacyPanel] = useState(true);

  React.useEffect(() => {
    if (initialTabNonce && initialTabNonce > 0) {
      setActiveTab('historical');
    }
  }, [initialTabNonce]);

  const entityMap = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const lineMap = useMemo(() => new Map(statementLines.map((l) => [l.id, l])), [statementLines]);

  // Shared Drive Target Root Configuration
  const [driveFolders, setDriveFolders] = useState<DriveFolderItem[]>([]);
  const [driveFiles, setDriveFiles] = useState<DriveFileItem[]>([]);
  const [rootFolderId, setRootFolderId] = useState<string>('');
  const [rootFolderName, setRootFolderName] = useState<string>('Strata Treasury');
  const [loadingDrive, setLoadingDrive] = useState(false);
  const [driveSourceFolderId, setDriveSourceFolderId] = useState<string>('');
  const [driveSearchQuery, setDriveSearchQuery] = useState<string>('');

  // Gmail Scan State
  const [gmailPreset, setGmailPreset] = useState<'2025' | '2026' | '90d' | 'custom'>('2025');
  const [gmailQuery, setGmailQuery] = useState<string>('');
  const [gmailAfter, setGmailAfter] = useState<string>('2025-01-01');
  const [gmailBefore, setGmailBefore] = useState<string>('2025-12-31');
  const [scanningGmail, setScanningGmail] = useState(false);
  const [gmailMessages, setGmailMessages] = useState<GmailCandidateMessage[]>([]);
  const [extractingKey, setExtractingKey] = useState<string>('');

  // Invoice Review & Batch Queue State
  const [reviewItem, setReviewItem] = useState<PendingInvoiceReview | null>(null);
  const [batchQueue, setBatchQueue] = useState<PendingInvoiceReview[]>([]);
  const [driveConfirm, setDriveConfirm] = useState<DriveConfirmState | null>(null);
  const [executingDrive, setExecutingDrive] = useState(false);

  // Vault Tab State
  const [vaultFilter, setVaultFilter] = useState<'all' | 'reconciled' | 'filed' | 'inbox'>('all');
  const [vaultSearch, setVaultSearch] = useState('');
  const [matchingVaultDoc, setMatchingVaultDoc] = useState<InvoiceDocument | null>(null);

  // Historical Batch Import Tab State
  const [histPreserveBalance, setHistPreserveBalance] = useState(true);
  const [histUseLocalCsv, setHistUseLocalCsv] = useState(true);
  const [histEntityId, setHistEntityId] = useState<string>(() => entities[0]?.id ?? '');
  const [histAccountId, setHistAccountId] = useState<string>(() => accounts[0]?.id ?? '');
  const [histParsing, setHistParsing] = useState(false);
  const [histStatements, setHistStatements] = useState<ParsedStatementDraft[]>([]);
  const [histInvoices, setHistInvoices] = useState<PendingInvoiceReview[]>([]);
  const [histPayslips, setHistPayslips] = useState<ParsedPayslipDraft[]>([]);
  const [histImporting, setHistImporting] = useState(false);

  // Drive Statement & Payslip Auto-Generator Workbench State
  const [selectedDriveIds, setSelectedDriveIds] = useState<string[]>([]);
  const [driveProcessing, setDriveProcessing] = useState(false);
  const [driveProgressLabel, setDriveProgressLabel] = useState('');
  const [genEntityId, setGenEntityId] = useState<string>('');
  const [genAccountId, setGenAccountId] = useState<string>('');
  const [genPreserveBalance, setGenPreserveBalance] = useState(true);
  const [genMarkPayslipsPaid, setGenMarkPayslipsPaid] = useState(true);
  const [genCreateLedgerTx, setGenCreateLedgerTx] = useState(true);
  const [genSaving, setGenSaving] = useState(false);
  const [genWorkbenchTab, setGenWorkbenchTab] = useState<
    'contracts' | 'payslips' | 'subscriptions' | 'facilities' | 'expenses'
  >('subscriptions');
  const [genStatements, setGenStatements] = useState<
    Array<{
      filename: string;
      statementPeriod: string;
      openingBalance: number;
      closingBalance: number;
      selected: boolean;
      lines: Array<{
        date: string;
        description: string;
        amount: number;
        direction: 'credit' | 'debit';
        includeTx: boolean;
        vendor: string;
        category: string;
        type: TransactionType;
        ivaRate: number;
        ivaDeductible: boolean;
      }>;
    }>
  >([]);
  const [genPayslips, setGenPayslips] = useState<Array<ParsedPayslipDraft & { selected: boolean }>>([]);
  const [genContracts, setGenContracts] = useState<Array<SuggestedContractDraft & { selected: boolean }>>([]);
  const [genSubscriptions, setGenSubscriptions] = useState<
    Array<SuggestedSubscriptionDraft & { selected: boolean }>
  >([]);
  const [genFacilities, setGenFacilities] = useState<Array<SuggestedFacilityDraft & { selected: boolean }>>(
    []
  );

  const histStmtRef = useRef<HTMLInputElement | null>(null);
  const histInvRef = useRef<HTMLInputElement | null>(null);
  const histPayRef = useRef<HTMLInputElement | null>(null);

  const resolvedHistEntityId =
    entityMap.has(histEntityId) ? histEntityId : entities[0]?.id ?? '';
  const histEntityAccounts = useMemo(
    () => accounts.filter((a) => a.entityId === resolvedHistEntityId),
    [accounts, resolvedHistEntityId]
  );
  const resolvedHistAccountId = histEntityAccounts.some((a) => a.id === histAccountId)
    ? histAccountId
    : histEntityAccounts[0]?.id ?? accounts[0]?.id ?? '';

  const resolvedGenEntityId = entityMap.has(genEntityId) ? genEntityId : entities[0]?.id ?? '';
  const genEntityAccounts = useMemo(
    () => accounts.filter((a) => a.entityId === resolvedGenEntityId),
    [accounts, resolvedGenEntityId]
  );
  const resolvedGenAccountId = genEntityAccounts.some((a) => a.id === genAccountId)
    ? genAccountId
    : genEntityAccounts[0]?.id ?? accounts[0]?.id ?? '';

  const hasGeneratedDrafts =
    genStatements.length > 0 ||
    genPayslips.length > 0 ||
    genContracts.length > 0 ||
    genSubscriptions.length > 0 ||
    genFacilities.length > 0;

  const applyGmailPreset = (preset: '2025' | '2026' | '90d' | 'custom') => {
    setGmailPreset(preset);
    if (preset === '2025') {
      setGmailAfter('2025-01-01');
      setGmailBefore('2025-12-31');
    } else if (preset === '2026') {
      setGmailAfter('2026-01-01');
      setGmailBefore('');
    } else if (preset === '90d') {
      const d = new Date();
      d.setDate(d.getDate() - 90);
      setGmailAfter(d.toISOString().slice(0, 10));
      setGmailBefore('');
    }
  };

  const authHeaders = () => {
    if (!workspaceToken) {
      throw new Error('Google Workspace session token is not active.');
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${workspaceToken}`,
    };
  };

  const handleWorkspaceResponse = async (res: ApiResponse) => {
    if (res.status === 401) {
      clearWorkspaceToken();
      throw new Error('Google Workspace session expired. Click "Connect Gmail & Drive Session" to continue.');
    }
    const rawText = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
    } catch {
      if (!res.ok) {
        throw new Error(
          res.status === 503
            ? 'AI extraction service is temporarily busy (503). Please retry in a few seconds.'
            : `Workspace request failed (${res.status}).`
        );
      }
    }
    if (!res.ok) {
      const errField = json.error;
      if (typeof errField === 'string') {
        throw new Error(errField);
      }
      if (errField && typeof errField === 'object' && 'message' in errField && typeof (errField as { message?: unknown }).message === 'string') {
        throw new Error((errField as { message: string }).message);
      }
      throw new Error(`Workspace request failed (${res.status}).`);
    }
    return json;
  };

  const buildReviewFromDraft = (opts: {
    source: 'gmail' | 'drive' | 'upload';
    draft: ParsedInvoiceDraft;
    filename: string;
    mimeType: string;
    base64Data?: string;
    gmailMessageId?: string;
    existingDriveFileId?: string;
    existingDriveWebViewLink?: string;
    historicalPreserveBalance?: boolean;
  }): PendingInvoiceReview => {
    const hint = (opts.draft.entityHint || '').toLowerCase();
    const matchedEntity =
      entities.find((e) => hint && e.name.toLowerCase().includes(hint)) ??
      entities.find((e) => e.entityType === 'company') ??
      entities[0];
    const entityId = matchedEntity?.id ?? '';
    const entAccount =
      accounts.find((a) => a.entityId === entityId) ?? accounts[0];

    const amt = Math.max(0, Number(opts.draft.amount) || 0);
    const ivaRate = Math.min(30, Math.max(0, Number(opts.draft.ivaRate) || 0));
    const ivaAmount =
      typeof opts.draft.ivaAmount === 'number' && opts.draft.ivaAmount >= 0
        ? Number(opts.draft.ivaAmount)
        : computeTransactionIva(amt, ivaRate);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(opts.draft.date)
      ? opts.draft.date
      : todayIsoDate();

    const matches = findMatchingStatementLines(
      { date, amount: amt, vendor: opts.draft.vendor || opts.filename, entityId },
      statementLines.filter((l) => l.reconciliationStatus !== 'reconciled')
    );

    return {
      source: opts.source,
      gmailMessageId: opts.gmailMessageId || '',
      existingDriveFileId: opts.existingDriveFileId || '',
      existingDriveWebViewLink: opts.existingDriveWebViewLink || '',
      mimeType: opts.mimeType || 'application/pdf',
      base64Data: opts.base64Data || '',
      filename: opts.filename || 'invoice.pdf',
      vendor: opts.draft.vendor || 'Vendor',
      vendorNif: opts.draft.vendorNif || '',
      invoiceNumber: opts.draft.invoiceNumber || '',
      date,
      amount: amt,
      ivaRate,
      ivaAmount,
      ivaDeductible: Boolean(opts.draft.ivaDeductible),
      category: opts.draft.category || 'Operating Expense',
      description: opts.draft.description || `${opts.draft.vendor || 'Invoice'} · ${opts.filename}`,
      entityId,
      accountId: entAccount?.id ?? '',
      isCrossEntityReimb: false,
      paidByEntityId: '',
      matchedStatementLineId: matches[0]?.line.id ?? '',
      historicalPreserveBalance: Boolean(opts.historicalPreserveBalance),
      notes: opts.draft.notes || '',
    };
  };

  const handleScanGmail = async () => {
    setScanningGmail(true);
    try {
      const res = await apiFetch('/api/workspace/gmail/scan', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          q: gmailQuery,
          afterDate: gmailAfter,
          beforeDate: gmailBefore,
          maxResults: 25,
        }),
      });
      const json = (await handleWorkspaceResponse(res)) as {
        messages?: GmailCandidateMessage[];
      };
      const msgs = Array.isArray(json.messages) ? json.messages : [];
      setGmailMessages(msgs);
      pushToast(
        'Gmail scan complete',
        `Found ${msgs.length} email${msgs.length === 1 ? '' : 's'} with PDF/image/CSV attachments.`,
        msgs.length > 0 ? 'success' : 'info'
      );
    } catch (err) {
      pushToast('Gmail scan failed', err instanceof Error ? err.message : 'Error scanning Gmail', 'error');
    } finally {
      setScanningGmail(false);
    }
  };

  const handleExtractGmailAttachment = async (
    msg: GmailCandidateMessage,
    att: GmailCandidateMessage['attachments'][number],
    queueOnly = false
  ) => {
    const key = `${msg.messageId}_${att.attachmentId}`;
    setExtractingKey(key);
    try {
      const res = await apiFetch('/api/workspace/gmail/extract-attachment', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          messageId: msg.messageId,
          attachmentId: att.attachmentId,
          filename: att.filename,
          mimeType: att.mimeType,
          runAiExtract: true,
          entityNames: entities.map((e) => e.name),
        }),
      });
      const json = (await handleWorkspaceResponse(res)) as {
        filename: string;
        mimeType: string;
        base64Data: string;
        extracted?: ParsedInvoiceDraft;
      };
      if (!json.extracted) {
        throw new Error('AI extraction returned no structured fields.');
      }
      const pending = buildReviewFromDraft({
        source: 'gmail',
        draft: json.extracted,
        filename: json.filename,
        mimeType: json.mimeType,
        base64Data: json.base64Data,
        gmailMessageId: msg.messageId,
        historicalPreserveBalance: json.extracted.date?.startsWith('2025-'),
      });
      if (queueOnly) {
        setBatchQueue((prev) => [...prev, pending]);
        pushToast('Added to batch queue', `${pending.vendor} (${pending.filename})`, 'success');
      } else {
        setReviewItem(pending);
      }
    } catch (err) {
      pushToast(
        'Extraction failed',
        err instanceof Error ? err.message : 'Unable to extract attachment.',
        'error'
      );
    } finally {
      setExtractingKey('');
    }
  };

  const handleListDrive = async (folderOverride?: string) => {
    setLoadingDrive(true);
    try {
      const res = await apiFetch('/api/workspace/drive/list', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          folderId: folderOverride !== undefined ? folderOverride : driveSourceFolderId,
          query: driveSearchQuery,
        }),
      });
      const json = (await handleWorkspaceResponse(res)) as {
        folders?: DriveFolderItem[];
        files?: DriveFileItem[];
      };
      setDriveFolders(Array.isArray(json.folders) ? json.folders : []);
      setDriveFiles(Array.isArray(json.files) ? json.files : []);
    } catch (err) {
      pushToast(
        'Drive listing failed',
        err instanceof Error ? err.message : 'Unable to list Google Drive.',
        'error'
      );
    } finally {
      setLoadingDrive(false);
    }
  };

  const handleExtractDriveFile = async (file: DriveFileItem) => {
    setExtractingKey(file.id);
    try {
      const res = await apiFetch('/api/workspace/drive/extract-file', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          fileId: file.id,
          filename: file.name,
          mimeType: file.mimeType,
          entityNames: entities.map((e) => e.name),
        }),
      });
      const json = (await handleWorkspaceResponse(res)) as {
        file?: DriveFileItem;
        extracted?: ParsedInvoiceDraft;
      };
      if (!json.extracted) {
        throw new Error('Could not extract invoice metadata from Drive file.');
      }
      const pending = buildReviewFromDraft({
        source: 'drive',
        draft: json.extracted,
        filename: json.file?.name || file.name,
        mimeType: json.file?.mimeType || file.mimeType,
        existingDriveFileId: file.id,
        existingDriveWebViewLink: json.file?.webViewLink || file.webViewLink || '',
        historicalPreserveBalance: json.extracted.date?.startsWith('2025-'),
      });
      setReviewItem(pending);
    } catch (err) {
      pushToast(
        'Drive extraction failed',
        err instanceof Error ? err.message : 'Unable to inspect Drive file.',
        'error'
      );
    } finally {
      setExtractingKey('');
    }
  };

  const processDriveFilesAsStatements = async (files: DriveFileItem[]) => {
    if (files.length === 0) return;
    setDriveProcessing(true);
    try {
      const parsedStmts: typeof genStatements = [];
      const failedFiles: Array<{ name: string; reason: string }> = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setDriveProgressLabel(`Extracting statement ${i + 1}/${files.length}: ${file.name}`);
        try {
          const res = await apiFetch('/api/workspace/drive/extract-statement', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
              fileId: file.id,
              filename: file.name,
              mimeType: file.mimeType,
            }),
          });
          const json = (await handleWorkspaceResponse(res)) as {
            file?: DriveFileItem;
            data?: ParsedStatementDraft;
          };
          if (json.data && Array.isArray(json.data.lines) && json.data.lines.length > 0) {
            parsedStmts.push({
              filename: json.data.filename || file.name,
              statementPeriod: json.data.statementPeriod || '',
              openingBalance: Number(json.data.openingBalance) || 0,
              closingBalance: Number(json.data.closingBalance) || 0,
              selected: true,
              lines: json.data.lines.map((l) => ({
                date: l.date,
                description: l.description,
                amount: Number(l.amount) || 0,
                direction: l.direction === 'credit' ? 'credit' : 'debit',
                includeTx: true,
                vendor: '',
                category: l.direction === 'credit' ? 'Revenue & Inflows' : 'Operating Expense',
                type: l.direction === 'credit' ? 'income' : 'expense',
                ivaRate: 23,
                ivaDeductible: l.direction !== 'credit',
              })),
            });
          }
        } catch (fileErr) {
          const msg = fileErr instanceof Error ? fileErr.message : 'Unable to extract statement.';
          if (msg.includes('session expired')) throw fileErr;
          failedFiles.push({ name: file.name, reason: msg });
        }
      }

      if (failedFiles.length > 0) {
        pushToast(
          `${failedFiles.length} statement(s) failed`,
          `${failedFiles[0].name}: ${failedFiles[0].reason}`,
          parsedStmts.length > 0 ? 'info' : 'error'
        );
      }

      if (parsedStmts.length === 0) {
        if (failedFiles.length === 0) {
          pushToast('No statement lines found', 'Selected Drive files had no readable transactions.', 'info');
        }
        return;
      }

      // Run AI pattern discovery in batches of 100 lines across extracted statements
      const newSubs: SuggestedSubscriptionDraft[] = [];
      const newFacs: SuggestedFacilityDraft[] = [];
      let patternDiscoveryFailures = 0;

      for (let sIdx = 0; sIdx < parsedStmts.length; sIdx++) {
        const stmt = parsedStmts[sIdx];
        for (let offset = 0; offset < stmt.lines.length; offset += 100) {
          const chunk = stmt.lines.slice(offset, offset + 100);
          setDriveProgressLabel(
            `Discovering subscriptions, loans & expenses (${stmt.filename} ${offset + 1}-${offset + chunk.length})`
          );
          const discRes = await apiFetch('/api/workspace/discover-patterns', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lines: chunk.map((l) => ({
                date: l.date,
                description: l.description,
                amount: l.amount,
                direction: l.direction,
              })),
              entityNames: entities.map((e) => e.name),
            }),
          });
          if (discRes.ok) {
            const discJson = (await discRes.json()) as {
              suggestedSubscriptions?: SuggestedSubscriptionDraft[];
              suggestedCreditFacilities?: SuggestedFacilityDraft[];
              suggestedTransactions?: SuggestedStatementTransactionDraft[];
            };
            if (Array.isArray(discJson.suggestedSubscriptions)) {
              newSubs.push(...discJson.suggestedSubscriptions);
            }
            if (Array.isArray(discJson.suggestedCreditFacilities)) {
              newFacs.push(...discJson.suggestedCreditFacilities);
            }
            if (Array.isArray(discJson.suggestedTransactions)) {
              for (const tx of discJson.suggestedTransactions) {
                const targetLine = stmt.lines[offset + Number(tx.lineIndex)];
                if (targetLine) {
                  targetLine.vendor = tx.vendor || '';
                  targetLine.category = tx.category || targetLine.category;
                  targetLine.type = tx.type || targetLine.type;
                  targetLine.ivaRate = Number(tx.ivaRate ?? 0);
                  targetLine.ivaDeductible = Boolean(tx.ivaDeductible);
                }
              }
            }
          } else {
            patternDiscoveryFailures += 1;
          }
        }
      }

      setGenStatements((prev) => [...prev, ...parsedStmts]);

      setGenSubscriptions((prev) => {
        const merged = new Map<string, SuggestedSubscriptionDraft & { selected: boolean }>();
        for (const item of prev) {
          merged.set(`${item.vendor.toLowerCase()}::${item.name.toLowerCase()}`, item);
        }
        for (const sub of newSubs) {
          const k = `${(sub.vendor || sub.name).toLowerCase()}::${(sub.name || sub.vendor).toLowerCase()}`;
          const existing = merged.get(k);
          if (existing) {
            merged.set(k, {
              ...existing,
              matchCount: existing.matchCount + (sub.matchCount || 1),
              sampleDates: Array.from(new Set([...existing.sampleDates, ...(sub.sampleDates || [])])),
            });
          } else {
            merged.set(k, { ...sub, selected: true });
          }
        }
        return Array.from(merged.values());
      });

      setGenFacilities((prev) => {
        const merged = new Map<string, SuggestedFacilityDraft & { selected: boolean }>();
        for (const item of prev) {
          merged.set(`${item.name.toLowerCase()}::${item.lender.toLowerCase()}`, item);
        }
        for (const fac of newFacs) {
          const k = `${fac.name.toLowerCase()}::${fac.lender.toLowerCase()}`;
          if (!merged.has(k)) {
            merged.set(k, { ...fac, selected: true });
          }
        }
        return Array.from(merged.values());
      });

      setGenWorkbenchTab(newSubs.length > 0 ? 'subscriptions' : 'expenses');
      setSelectedDriveIds([]);
      const totalLines = parsedStmts.reduce((acc, s) => acc + s.lines.length, 0);
      pushToast(
        'Bank statements analyzed from Drive',
        patternDiscoveryFailures > 0
          ? `${parsedStmts.length} statement(s) · ${totalLines} lines extracted (${patternDiscoveryFailures} AI discovery batch(es) skipped due to API rate/error).`
          : `${parsedStmts.length} statement(s) · ${totalLines} lines · ${newSubs.length} subscriptions & ${newFacs.length} credit facilities discovered.`,
        patternDiscoveryFailures > 0 ? 'info' : 'success'
      );
    } catch (err) {
      pushToast(
        'Statement processing failed',
        err instanceof Error ? err.message : 'Unable to extract Drive statement.',
        'error'
      );
    } finally {
      setDriveProcessing(false);
      setDriveProgressLabel('');
    }
  };

  const processDriveFilesAsPayslips = async (files: DriveFileItem[]) => {
    if (files.length === 0) return;
    setDriveProcessing(true);
    try {
      const extractedSlips: Array<ParsedPayslipDraft & { selected: boolean }> = [];
      const extractedContracts: SuggestedContractDraft[] = [];
      const failedFiles: Array<{ name: string; reason: string }> = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setDriveProgressLabel(`Extracting payslip ${i + 1}/${files.length}: ${file.name}`);
        try {
          const res = await apiFetch('/api/workspace/drive/extract-payslip', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
              fileId: file.id,
              filename: file.name,
              mimeType: file.mimeType,
            }),
          });
          const json = (await handleWorkspaceResponse(res)) as {
            items?: Array<Omit<ParsedPayslipDraft, 'sourceFilename'>>;
            suggestedContracts?: SuggestedContractDraft[];
          };
          if (Array.isArray(json.items)) {
            for (const slip of json.items) {
              extractedSlips.push({
                ...slip,
                sourceFilename: file.name,
                selected: true,
              });
            }
          }
          if (Array.isArray(json.suggestedContracts)) {
            extractedContracts.push(...json.suggestedContracts);
          }
        } catch (fileErr) {
          const msg = fileErr instanceof Error ? fileErr.message : 'Unable to extract payslip.';
          if (msg.includes('session expired')) throw fileErr;
          failedFiles.push({ name: file.name, reason: msg });
        }
      }

      if (failedFiles.length > 0) {
        pushToast(
          `${failedFiles.length} payslip file(s) failed`,
          `${failedFiles[0].name}: ${failedFiles[0].reason}`,
          extractedSlips.length > 0 ? 'info' : 'error'
        );
      }

      if (extractedSlips.length === 0 && extractedContracts.length === 0) {
        if (failedFiles.length === 0) {
          pushToast('No payslips found', 'Could not extract employee payroll entries from selected files.', 'info');
        }
        return;
      }

      setGenPayslips((prev) => [...prev, ...extractedSlips]);
      setGenContracts((prev) => {
        const map = new Map<string, SuggestedContractDraft & { selected: boolean }>();
        for (const item of prev) {
          map.set(item.workerName.trim().toLowerCase(), item);
        }
        for (const ctr of extractedContracts) {
          const key = ctr.workerName.trim().toLowerCase();
          if (!key) continue;
          if (!map.has(key)) {
            map.set(key, { ...ctr, selected: true });
          }
        }
        return Array.from(map.values());
      });

      setGenWorkbenchTab(extractedContracts.length > 0 ? 'contracts' : 'payslips');
      setSelectedDriveIds([]);
      pushToast(
        'Payslips & contracts extracted from Drive',
        `${extractedSlips.length} employee payslip(s) and ${extractedContracts.length} contract rule(s) ready to save.`,
        'success'
      );
    } catch (err) {
      pushToast(
        'Payslip extraction failed',
        err instanceof Error ? err.message : 'Unable to extract Drive payslip.',
        'error'
      );
    } finally {
      setDriveProcessing(false);
      setDriveProgressLabel('');
    }
  };

  const commitDriveWorkbenchToFirebase = async () => {
    if (!resolvedGenEntityId || !resolvedGenAccountId) {
      pushToast('Select Entity & Account', 'Choose the target entity and bank account before saving.', 'error');
      return;
    }
    setGenSaving(true);
    try {
      const saved = await importDriveGeneratedBundle({
        entityId: resolvedGenEntityId,
        accountId: resolvedGenAccountId,
        adjustAccountBalance: !genPreserveBalance,
        markPayslipsPaid: genMarkPayslipsPaid,
        contracts: genContracts.filter((c) => c.selected),
        payslips: genPayslips
          .filter((p) => p.selected)
          .map((p) => ({
            entityId: resolvedGenEntityId,
            contractId: '',
            employeeName: p.employeeName,
            periodStart: p.periodStart,
            periodEnd: p.periodEnd,
            payDate: p.payDate,
            taxDueDate: p.taxDueDate,
            grossPay: p.grossPay,
            netPay: p.netPay,
            employeeWithholdings: p.employeeWithholdings,
            employerTaxes: p.employerTaxes,
            employerContributions: p.employerContributions,
            payStatus: genMarkPayslipsPaid ? 'paid' : 'scheduled',
            taxStatus: genMarkPayslipsPaid ? 'paid' : 'scheduled',
            sourceFilename: p.sourceFilename,
          })),
        subscriptions: genSubscriptions.filter((s) => s.selected),
        facilities: genFacilities.filter((f) => f.selected),
        statements: genStatements
          .filter((s) => s.selected)
          .map((s) => ({
            filename: s.filename,
            statementPeriod: s.statementPeriod,
            openingBalance: s.openingBalance,
            closingBalance: s.closingBalance,
            lines: s.lines.map((l) => ({
              date: l.date,
              description: l.description,
              amount: l.amount,
              direction: l.direction,
              generatedTx:
                genCreateLedgerTx && l.includeTx
                  ? {
                      vendor: l.vendor,
                      category: l.category,
                      type: l.type,
                      ivaRate: l.ivaRate,
                      ivaDeductible: l.ivaDeductible,
                    }
                  : undefined,
            })),
          })),
      });
      if (saved && loadedAtlasImport) {
        // Committed: the import has done its job; Atlas won't overwrite it now.
        await decideAtlasImport(loadedAtlasImport.id, 'applied').catch((err) =>
          pushToast('Saved, but the import stays pending', err instanceof Error ? err.message : String(err), 'info')
        );
        setLoadedAtlasImport(null);
      }
      setGenStatements([]);
      setGenPayslips([]);
      setGenContracts([]);
      setGenSubscriptions([]);
      setGenFacilities([]);
    } finally {
      setGenSaving(false);
    }
  };

  /** Puts one of Atlas's imports in the review workbench (the Drive tab), replacing what was there. */
  const openAtlasImport = (imp: AtlasImport) => {
    const entity = entityForHint(imp.entityHint, entities);
    if (entity) setGenEntityId(entity.id);
    setGenStatements(
      imp.statements.map((st) => ({
        ...st,
        selected: true,
        lines: st.lines.map((l) => ({ ...l, includeTx: true })),
      }))
    );
    setGenPayslips(imp.payslips.map((p) => ({ ...p, selected: true })));
    setGenContracts(imp.contracts.map((c) => ({ ...c, selected: true })));
    setGenSubscriptions(imp.subscriptions.map((x) => ({ ...x, selected: true })));
    setGenFacilities(imp.facilities.map((f) => ({ ...f, selected: true })));
    setGenWorkbenchTab(
      imp.contracts.length > 0 ? 'contracts' : imp.payslips.length > 0 ? 'payslips' : imp.subscriptions.length > 0 ? 'subscriptions' : 'expenses'
    );
    setLoadedAtlasImport(imp);
    setActiveTab('drive');
    pushToast(
      `Atlas's import for ${imp.entityHint || 'an entity'} · ${imp.month} is in the workbench`,
      entity
        ? 'Check the entity and account at the top of the workbench, untick anything wrong, then commit.'
        : `No entity named "${imp.entityHint}": pick the entity and account at the top of the workbench before committing.`,
      'info'
    );
  };

  const dismissAtlasImport = async (imp: AtlasImport) => {
    setDecidingAtlasImport(imp.id);
    try {
      await decideAtlasImport(imp.id, 'dismissed');
      if (loadedAtlasImport?.id === imp.id) setLoadedAtlasImport(null);
    } catch (err) {
      pushToast('Could not set it aside', err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setDecidingAtlasImport('');
    }
  };

  const executeConfirmedDriveFiling = async () => {
    if (!driveConfirm || driveConfirm.items.length === 0) return;
    setExecutingDrive(true);
    let filedCount = 0;
    try {
      for (const item of driveConfirm.items) {
        const entity = entityMap.get(item.entityId);
        const year = item.date.slice(0, 4) || String(new Date().getUTCFullYear());
        const res = await apiFetch('/api/workspace/drive/file-invoice', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            rootFolderId: driveConfirm.rootFolderId || undefined,
            rootFolderName: driveConfirm.rootFolderName || 'Strata Treasury',
            entityName: entity?.name || 'General',
            year,
            docCategory: driveConfirm.docCategory || 'Invoices',
            filename: item.filename,
            mimeType: item.mimeType || 'application/pdf',
            base64Data: item.existingDriveFileId ? undefined : item.base64Data,
            existingDriveFileId: item.existingDriveFileId || undefined,
          }),
        });
        const filed = (await handleWorkspaceResponse(res)) as {
          driveFileId: string;
          driveWebViewLink: string;
          driveFolderId: string;
          driveFolderPath: string;
        };

        const matchedLine = item.matchedStatementLineId
          ? lineMap.get(item.matchedStatementLineId)
          : undefined;

        await createLedgerAndFileInvoice({
          invoiceInput: {
            entityId: item.entityId,
            accountId: item.accountId,
            transactionId: '',
            statementLineId: matchedLine?.id || '',
            reimbursementId: '',
            source: item.source,
            vendor: item.vendor,
            vendorNif: item.vendorNif,
            invoiceNumber: item.invoiceNumber,
            date: item.date,
            amount: item.amount,
            ivaRate: item.ivaRate,
            ivaAmount: item.ivaAmount,
            ivaDeductible: item.ivaDeductible,
            filename: item.filename,
            driveFileId: filed.driveFileId,
            driveWebViewLink: filed.driveWebViewLink,
            driveFolderId: filed.driveFolderId,
            driveFolderPath: filed.driveFolderPath,
            gmailMessageId: item.gmailMessageId,
            status: matchedLine ? 'reconciled' : 'filed',
          },
          accountId: item.accountId,
          category: item.category,
          description: item.description,
          createReimbursementToEntityId: item.isCrossEntityReimb
            ? item.paidByEntityId
            : undefined,
          adjustAccountBalance: !item.historicalPreserveBalance,
          matchedStatementLine: matchedLine,
        });
        filedCount++;
      }

      if (driveConfirm.mode === 'single') {
        setReviewItem(null);
      } else {
        setBatchQueue([]);
      }
      setDriveConfirm(null);
      if (filedCount > 1) {
        pushToast(
          'Batch filed to Drive & Ledger',
          `${filedCount} invoices organized into Google Drive and recorded.`,
          'success'
        );
      }
    } catch (err) {
      pushToast(
        'Filing failed',
        err instanceof Error ? err.message : 'Unable to complete Drive filing.',
        'error'
      );
    } finally {
      setExecutingDrive(false);
    }
  };

  // Historical Batch Handlers
  const handleHistStatementsSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setHistParsing(true);
    try {
      const drafts: ParsedStatementDraft[] = [];
      for (const file of files) {
        const isCsv = file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv';
        if (isCsv && histUseLocalCsv) {
          const text = await file.text();
          drafts.push(parseLocalBankCsv(text, file.name));
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
            throw new Error(json.error || `Failed to parse ${file.name}`);
          }
          drafts.push({
            filename: file.name,
            statementPeriod: json.data.statementPeriod || '2025 Historical',
            openingBalance: Number(json.data.openingBalance) || 0,
            closingBalance: Number(json.data.closingBalance) || 0,
            lines: Array.isArray(json.data.lines) ? json.data.lines : [],
          });
        }
      }
      setHistStatements((prev) => [...prev, ...drafts]);
      pushToast('Statements ready', `${drafts.length} file(s) parsed for review.`, 'success');
    } catch (err) {
      pushToast(
        'Statement parse failed',
        err instanceof Error ? err.message : 'Could not parse statement.',
        'error'
      );
    } finally {
      setHistParsing(false);
    }
  };

  const handleHistInvoicesSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setHistParsing(true);
    try {
      const items: PendingInvoiceReview[] = [];
      for (const file of files) {
        const payload = await readUploadPayload(file);
        const resp = await apiFetch('/api/parse/invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            entityNames: entities.map((ent) => ent.name),
          }),
        });
        const json = (await resp.json()) as { data?: ParsedInvoiceDraft; error?: string };
        if (!resp.ok || !json.data) {
          throw new Error(json.error || `Failed to parse ${file.name}`);
        }
        items.push(
          buildReviewFromDraft({
            source: 'upload',
            draft: json.data,
            filename: file.name,
            mimeType: payload.mimeType,
            base64Data: payload.base64Data || '',
            historicalPreserveBalance: histPreserveBalance,
          })
        );
      }
      setHistInvoices((prev) => [...prev, ...items]);
      pushToast('Invoices extracted', `${items.length} invoice(s) queued.`, 'success');
    } catch (err) {
      pushToast(
        'Invoice parse failed',
        err instanceof Error ? err.message : 'Could not extract invoice.',
        'error'
      );
    } finally {
      setHistParsing(false);
    }
  };

  const handleHistPayslipsSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setHistParsing(true);
    try {
      const items: ParsedPayslipDraft[] = [];
      for (const file of files) {
        const payload = await readUploadPayload(file);
        const resp = await apiFetch('/api/parse/payslip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = (await resp.json()) as {
          data?: Omit<ParsedPayslipDraft, 'sourceFilename'>;
          items?: Array<Omit<ParsedPayslipDraft, 'sourceFilename'>>;
          error?: string;
        };
        const extractedList =
          Array.isArray(json.items) && json.items.length > 0
            ? json.items
            : json.data
            ? [json.data]
            : [];
        if (!resp.ok || extractedList.length === 0) {
          throw new Error(json.error || `Failed to parse ${file.name}`);
        }
        for (const slip of extractedList) {
          items.push({ ...slip, sourceFilename: file.name });
        }
      }
      setHistPayslips((prev) => [...prev, ...items]);
      pushToast('Payslips extracted', `${items.length} payslip(s) ready to import.`, 'success');
    } catch (err) {
      pushToast(
        'Payslip parse failed',
        err instanceof Error ? err.message : 'Could not parse payslip.',
        'error'
      );
    } finally {
      setHistParsing(false);
    }
  };

  const commitHistStatements = async () => {
    const acc = accountMap.get(resolvedHistAccountId);
    if (!acc || histStatements.length === 0) return;
    setHistImporting(true);
    try {
      for (const stmt of histStatements) {
        await importStatementBatch({
          entityId: acc.entityId,
          accountId: acc.id,
          filename: stmt.filename,
          statementPeriod: stmt.statementPeriod,
          openingBalance: stmt.openingBalance,
          closingBalance: stmt.closingBalance,
          lines: stmt.lines,
        });
      }
      setHistStatements([]);
    } finally {
      setHistImporting(false);
    }
  };

  const commitHistInvoicesLocally = async () => {
    if (histInvoices.length === 0) return;
    setHistImporting(true);
    try {
      for (const item of histInvoices) {
        const matchedLine = item.matchedStatementLineId
          ? lineMap.get(item.matchedStatementLineId)
          : undefined;
        await createLedgerAndFileInvoice({
          invoiceInput: {
            entityId: item.entityId,
            accountId: item.accountId,
            transactionId: '',
            statementLineId: matchedLine?.id || '',
            reimbursementId: '',
            source: 'upload',
            vendor: item.vendor,
            vendorNif: item.vendorNif,
            invoiceNumber: item.invoiceNumber,
            date: item.date,
            amount: item.amount,
            ivaRate: item.ivaRate,
            ivaAmount: item.ivaAmount,
            ivaDeductible: item.ivaDeductible,
            filename: item.filename,
            driveFileId: '',
            driveWebViewLink: '',
            driveFolderId: '',
            driveFolderPath: '',
            gmailMessageId: '',
            status: matchedLine ? 'reconciled' : 'inbox',
          },
          accountId: item.accountId,
          category: item.category,
          description: item.description,
          adjustAccountBalance: !histPreserveBalance,
          matchedStatementLine: matchedLine,
        });
      }
      setHistInvoices([]);
    } finally {
      setHistImporting(false);
    }
  };

  const commitHistPayslips = async () => {
    if (!resolvedHistEntityId || histPayslips.length === 0) return;
    setHistImporting(true);
    try {
      for (const p of histPayslips) {
        await addPayslip({
          entityId: resolvedHistEntityId,
          contractId: '',
          employeeName: p.employeeName,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          payDate: p.payDate,
          taxDueDate: p.taxDueDate,
          grossPay: Number(p.grossPay) || 0,
          netPay: Number(p.netPay) || 0,
          employeeWithholdings: Number(p.employeeWithholdings) || 0,
          employerTaxes: Number(p.employerTaxes) || 0,
          employerContributions: Number(p.employerContributions) || 0,
          payStatus: 'paid',
          taxStatus: 'paid',
          sourceFilename: p.sourceFilename,
        });
      }
      setHistPayslips([]);
    } finally {
      setHistImporting(false);
    }
  };

  // Vault filtered docs
  const visibleVaultDocs = useMemo(() => {
    const q = vaultSearch.trim().toLowerCase();
    return filteredInvoiceDocuments.filter((d) => {
      if (vaultFilter !== 'all' && d.status !== vaultFilter) return false;
      if (
        q &&
        !d.vendor.toLowerCase().includes(q) &&
        !d.invoiceNumber.toLowerCase().includes(q) &&
        !d.filename.toLowerCase().includes(q) &&
        !d.driveFolderPath.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [filteredInvoiceDocuments, vaultFilter, vaultSearch]);

  const vaultStats = useMemo(() => {
    return {
      total: filteredInvoiceDocuments.length,
      reconciled: filteredInvoiceDocuments.filter((d) => d.status === 'reconciled').length,
      filed: filteredInvoiceDocuments.filter((d) => d.driveWebViewLink).length,
      inbox: filteredInvoiceDocuments.filter((d) => d.status === 'inbox').length,
    };
  }, [filteredInvoiceDocuments]);

  const candidateStatementMatchesForReview = useMemo(() => {
    if (!reviewItem) return [];
    return findMatchingStatementLines(
      {
        date: reviewItem.date,
        amount: reviewItem.amount,
        vendor: reviewItem.vendor,
        entityId: reviewItem.entityId,
      },
      statementLines.filter((l) => l.reconciliationStatus !== 'reconciled')
    );
  }, [reviewItem, statementLines]);

  const candidateStatementMatchesForVault = useMemo(() => {
    if (!matchingVaultDoc) return [];
    return findMatchingStatementLines(
      {
        date: matchingVaultDoc.date,
        amount: matchingVaultDoc.amount,
        vendor: matchingVaultDoc.vendor,
        entityId: matchingVaultDoc.entityId,
      },
      filteredStatementLines
    );
  }, [matchingVaultDoc, filteredStatementLines]);

  const unlinkedStatementLinesForVault = useMemo(() => {
    if (!matchingVaultDoc) return [];
    const suggestedIds = new Set(candidateStatementMatchesForVault.map((m) => m.line.id));
    const rest = filteredStatementLines.filter(
      (l) => !suggestedIds.has(l.id) && l.entityId === matchingVaultDoc.entityId
    );
    return [
      ...candidateStatementMatchesForVault.map((m) => ({ line: m.line, score: m.score })),
      ...rest.slice(0, 30).map((line) => ({ line, score: 0 })),
    ];
  }, [matchingVaultDoc, candidateStatementMatchesForVault, filteredStatementLines]);

  return (
    <div className="space-y-6">
      {/* Privacy & Data Architecture Banner */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <h2 className="text-sm font-semibold text-slate-100">
              Data Residency, Privacy &amp; Processing Architecture
            </h2>
          </div>
          <button
            onClick={() => setShowPrivacyPanel((v) => !v)}
            className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            {showPrivacyPanel ? 'Hide details' : 'Show privacy architecture'}
          </button>
        </div>

        {showPrivacyPanel && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-slate-800 text-xs">
            <div className="p-3.5 bg-[#1E293B]/50 border border-slate-800 rounded-lg space-y-1.5">
              <p className="font-semibold text-slate-100 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-sky-400" />
                Private Firestore &amp; Your Google Drive
              </p>
              <p className="text-slate-400 leading-relaxed">
                Structured accounting entries, tax settings, and reconciliation links are stored in your private{' '}
                <span className="text-slate-200">Firebase Firestore</span> space (isolated by your UID). Original
                invoice PDFs stay inside your own <span className="text-slate-200">Google Drive</span> folders—never
                saved on our server.
              </p>
            </div>
            <div className="p-3.5 bg-[#1E293B]/50 border border-slate-800 rounded-lg space-y-1.5">
              <p className="font-semibold text-slate-100 flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5 text-blue-400" />
                Ephemeral In-Memory OAuth Token
              </p>
              <p className="text-slate-400 leading-relaxed">
                Your <span className="text-slate-200">Gmail (read-only)</span> and{' '}
                <span className="text-slate-200">Google Drive</span> access token exists strictly in React RAM during
                your active session. It is never stored in <code className="text-slate-300">localStorage</code> or the
                database, and clears on reload or sign-out.
              </p>
            </div>
            <div className="p-3.5 bg-[#1E293B]/50 border border-slate-800 rounded-lg space-y-1.5">
              <p className="font-semibold text-slate-100 flex items-center gap-1.5">
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
                Transient AI &amp; Zero-AI Local CSV
              </p>
              <p className="text-slate-400 leading-relaxed">
                AI extraction runs strictly on click inside transient server memory with zero disk retention. For bank{' '}
                <code className="text-slate-300">.csv</code> statements, toggle{' '}
                <span className="text-slate-200">Local CSV Parser (Zero-AI)</span> to parse 100% locally inside your
                browser.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Google Workspace Connection & Target Folder Bar */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-semibold text-slate-100">
              Google Workspace Session (Gmail &amp; Drive)
            </span>
            {hasWorkspaceAccess ? (
              <span className="text-xs font-mono text-emerald-400">
                Connected in memory
              </span>
            ) : (
              <span className="text-xs font-mono text-amber-300">
                Session token required
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Target archive structure:{' '}
            <span className="font-mono text-slate-200">
              {rootFolderName || 'Strata Treasury'} / &lt;Entity&gt; / &lt;Year&gt; / Invoices
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {driveFolders.length > 0 ? (
            <select
              value={rootFolderId}
              onChange={(e) => {
                const fId = e.target.value;
                setRootFolderId(fId);
                const found = driveFolders.find((f) => f.id === fId);
                setRootFolderName(found ? found.name : 'Strata Treasury');
              }}
              className="bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 max-w-[220px]"
            >
              <option value="">Create / Use &ldquo;Strata Treasury&rdquo;</option>
              {driveFolders.map((f) => (
                <option key={f.id} value={f.id}>
                  Drive Folder: {f.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={rootFolderName}
              onChange={(e) => {
                setRootFolderId('');
                setRootFolderName(e.target.value);
              }}
              placeholder="Root Drive Folder"
              className="bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 w-44"
            />
          )}

          {hasWorkspaceAccess && (
            <button
              onClick={() => void handleListDrive('')}
              disabled={loadingDrive}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 rounded-lg whitespace-nowrap cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingDrive ? 'animate-spin' : ''}`} />
              <span>Load Drive Folders</span>
            </button>
          )}

          <button
            onClick={() => void connectGoogleWorkspace()}
            disabled={connectingWorkspace}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg whitespace-nowrap cursor-pointer ${
              hasWorkspaceAccess
                ? 'bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-slate-100'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            }`}
          >
            <FolderInput className="w-3.5 h-3.5" />
            <span>
              {connectingWorkspace
                ? 'Connecting...'
                : hasWorkspaceAccess
                ? 'Refresh Workspace Session'
                : 'Connect Gmail & Drive Session'}
            </span>
          </button>
        </div>
      </section>

      {/* Hub Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[#0F172A] border border-slate-800 rounded-lg">
          {(
            [
              { id: 'atlas', label: `From Atlas (${atlasImports.length})`, icon: Sparkles },
              { id: 'gmail', label: 'Gmail Invoices', icon: Mail },
              { id: 'drive', label: 'Drive Archive & Organizer', icon: Folder },
              { id: 'historical', label: 'Historical Batch Import (2025)', icon: History },
              { id: 'vault', label: `Invoice Vault (${vaultStats.total})`, icon: FileArchive },
            ] as Array<{ id: HubTab; label: string; icon: React.ComponentType<{ className?: string }> }>
          ).map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-4 text-xs font-mono tabular-nums text-slate-400">
          <span>{vaultStats.filed} in Drive</span>
          <span className="text-emerald-400">{vaultStats.reconciled} reconciled</span>
          {vaultStats.inbox > 0 && <span className="text-amber-300">{vaultStats.inbox} unlinked</span>}
        </div>
      </div>

      {/* ===================================================================== */}
      {/* FROM ATLAS: what Atlas read from the documents, waiting for review    */}
      {/* ===================================================================== */}
      {activeTab === 'atlas' && (
        <div className="space-y-5">
          <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 space-y-2">
            <h3 className="text-base font-semibold text-slate-100">Imports from Atlas</h3>
            <p className="text-xs text-slate-400">
              Atlas reads the payslips and bank statements in Drive and Gmail, one entity and month at a time, and
              proposes what it found: statement lines with their categories, payslips, contracts, subscriptions and
              loans. Open one in the review workbench, untick anything wrong, and commit: nothing reaches the books
              before that. Ask Atlas, for example: &ldquo;import March 2026 for Noisy Source&rdquo;.
            </p>
            {loadedAtlasImport && (
              <p className="text-xs text-blue-300">
                Open in the workbench: {loadedAtlasImport.entityHint} · {loadedAtlasImport.month}.{' '}
                <button className="underline cursor-pointer" onClick={() => setActiveTab('drive')}>
                  Go to it
                </button>
              </p>
            )}
            {atlasImportsError && (
              <p className="text-xs text-red-400 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" /> Couldn&rsquo;t read Atlas&rsquo;s imports: {atlasImportsError}
              </p>
            )}
          </div>

          {atlasImports.length === 0 ? (
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-8 text-center text-sm text-slate-400">
              Nothing waiting. When Atlas imports a month, it appears here.
            </div>
          ) : (
            <div className="space-y-3">
              {atlasImports.map((imp) => {
                const entity = entityForHint(imp.entityHint, entities);
                return (
                  <div key={imp.id} className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 space-y-3">
                    <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-100">
                          {imp.entityHint || 'Unnamed entity'} · {imp.month}
                          {!entity && (
                            <span className="ml-2 text-xs font-normal text-amber-300">
                              no entity with this name: pick one in the workbench
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">{countsOf(imp)}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => openAtlasImport(imp)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" /> Review in workbench
                        </button>
                        <button
                          onClick={() => dismissAtlasImport(imp)}
                          disabled={decidingAtlasImport === imp.id}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-700 text-slate-300 hover:text-slate-100 cursor-pointer disabled:opacity-50"
                        >
                          <X className="w-3.5 h-3.5" /> Set aside
                        </button>
                      </div>
                    </div>
                    {imp.summary && <p className="text-xs text-slate-300 whitespace-pre-line">{imp.summary}</p>}
                    {imp.sources.length > 0 && (
                      <details className="text-xs text-slate-400">
                        <summary className="cursor-pointer">Read from {imp.sources.length} document{imp.sources.length === 1 ? '' : 's'}</summary>
                        <ul className="mt-2 space-y-1">
                          {imp.sources.map((src, i) => (
                            <li key={`${src.id}-${i}`} className="flex items-center gap-1.5">
                              {src.kind === 'gmail' ? <Mail className="w-3 h-3" /> : <Folder className="w-3 h-3" />}
                              {src.link ? (
                                <a href={src.link} target="_blank" rel="noreferrer" className="underline hover:text-slate-200">
                                  {src.name || src.id}
                                </a>
                              ) : (
                                <span>{src.name || src.id}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 1: GMAIL INVOICES                                                 */}
      {/* ===================================================================== */}
      {activeTab === 'gmail' && (
        <div className="space-y-5">
          <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  Scan Gmail for Invoices &amp; Receipts
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Filters messages with PDF, image, or CSV attachments matching invoice/fatura keywords or your search terms.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1 p-1 bg-[#1E293B] border border-slate-700 rounded-lg">
                {(
                  [
                    ['2025', 'Last Year (2025)'],
                    ['2026', '2026 YTD'],
                    ['90d', 'Last 90 Days'],
                    ['custom', 'Custom'],
                  ] as Array<['2025' | '2026' | '90d' | 'custom', string]>
                ).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => applyGmailPreset(id)}
                    className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap cursor-pointer ${
                      gmailPreset === id
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="md:col-span-2">
                <label className="block text-xs text-slate-400 mb-1">
                  Gmail Search Filter (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. fatura OR google OR worten OR edp"
                  value={gmailQuery}
                  onChange={(e) => setGmailQuery(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">From Date</label>
                <input
                  type="date"
                  value={gmailAfter}
                  onChange={(e) => {
                    setGmailPreset('custom');
                    setGmailAfter(e.target.value);
                  }}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Before Date (Optional)</label>
                <input
                  type="date"
                  value={gmailBefore}
                  onChange={(e) => {
                    setGmailPreset('custom');
                    setGmailBefore(e.target.value);
                  }}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="text-xs text-slate-400">
                {batchQueue.length > 0 && (
                  <span className="text-blue-400 font-medium">
                    {batchQueue.length} invoice{batchQueue.length === 1 ? '' : 's'} queued for batch Drive filing
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {batchQueue.length > 0 && (
                  <button
                    onClick={() =>
                      setDriveConfirm({
                        mode: 'batch',
                        items: batchQueue,
                        rootFolderId,
                        rootFolderName: rootFolderName || 'Strata Treasury',
                        docCategory: 'Invoices',
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white rounded-lg whitespace-nowrap cursor-pointer"
                  >
                    <FolderInput className="w-3.5 h-3.5" />
                    <span>File Queued Batch ({batchQueue.length}) to Drive</span>
                  </button>
                )}
                <button
                  onClick={() => void handleScanGmail()}
                  disabled={!hasWorkspaceAccess || scanningGmail}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white rounded-lg whitespace-nowrap cursor-pointer"
                >
                  <Search className="w-3.5 h-3.5" />
                  <span>{scanningGmail ? 'Scanning Gmail...' : 'Scan Gmail Attachments'}</span>
                </button>
              </div>
            </div>
          </div>

          {!hasWorkspaceAccess ? (
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-8 text-center space-y-3">
              <p className="text-sm text-slate-200">
                Connect your in-memory Google Workspace session to scan Gmail for invoices.
              </p>
              <button
                onClick={() => void connectGoogleWorkspace()}
                disabled={connectingWorkspace}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                <Mail className="w-3.5 h-3.5" />
                <span>{connectingWorkspace ? 'Connecting...' : 'Connect Gmail & Drive Session'}</span>
              </button>
            </div>
          ) : gmailMessages.length === 0 ? (
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-8 text-center text-xs text-slate-400">
              Run a Gmail scan above to list invoice emails and PDF attachments from {gmailAfter || 'your inbox'}.
            </div>
          ) : (
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-6 py-3.5 border-b border-slate-800 text-xs text-slate-400 flex items-center justify-between">
                <span>Found {gmailMessages.length} email threads with attachments</span>
                <span>Click Extract &amp; Review to parse and file PDFs to Drive</span>
              </div>
              <div className="divide-y divide-slate-800/80">
                {gmailMessages.map((msg) => {
                  const alreadyLogged = filteredInvoiceDocuments.some(
                    (d) => d.gmailMessageId && d.gmailMessageId === msg.messageId
                  );
                  return (
                    <div key={msg.messageId} className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-800/25">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-mono tabular-nums text-slate-400">
                            {msg.dateIso}
                          </span>
                          <span className="text-sm font-medium text-slate-100 truncate">
                            {msg.subject}
                          </span>
                          {alreadyLogged && (
                            <span className="text-xs font-mono text-emerald-400">
                              Filed in Vault
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-400 truncate">{msg.from}</p>
                        {msg.snippet && (
                          <p className="text-xs text-slate-500 line-clamp-1">{msg.snippet}</p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {msg.attachments.map((att) => {
                          const key = `${msg.messageId}_${att.attachmentId}`;
                          const isBusy = extractingKey === key;
                          return (
                            <div
                              key={att.attachmentId}
                              className="flex items-center gap-1.5 bg-[#1E293B] border border-slate-700 rounded-lg px-2.5 py-1.5"
                            >
                              <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                              <span className="text-xs text-slate-200 max-w-[160px] truncate">
                                {att.filename}
                              </span>
                              <button
                                onClick={() => void handleExtractGmailAttachment(msg, att, false)}
                                disabled={Boolean(extractingKey)}
                                className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[11px] font-medium text-white rounded cursor-pointer whitespace-nowrap"
                              >
                                {isBusy ? 'Extracting...' : 'Extract & Review'}
                              </button>
                              <button
                                onClick={() => void handleExtractGmailAttachment(msg, att, true)}
                                disabled={Boolean(extractingKey)}
                                title="Extract and add to batch filing queue"
                                className="px-2 py-0.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-[11px] text-slate-200 rounded cursor-pointer whitespace-nowrap"
                              >
                                + Queue
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 2: DRIVE ARCHIVE & STATEMENT/PAYSLIP GENERATOR                    */}
      {/* ===================================================================== */}
      {activeTab === 'drive' && (
        <div className="space-y-5">
          <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1">
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Source Folder in Google Drive
                </label>
                <select
                  value={driveSourceFolderId}
                  onChange={(e) => setDriveSourceFolderId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                >
                  <option value="">All Drive Folders (PDFs, CSVs, Sheets, Images)</option>
                  {driveFolders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Filename Filter
                </label>
                <input
                  type="text"
                  placeholder="e.g. extrato, recibo, 2025, bpi, fatura..."
                  value={driveSearchQuery}
                  onChange={(e) => setDriveSearchQuery(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                />
              </div>
            </div>

            <button
              onClick={() => void handleListDrive()}
              disabled={!hasWorkspaceAccess || loadingDrive}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Search className="w-3.5 h-3.5" />
              <span>{loadingDrive ? 'Scanning Drive...' : 'Scan Google Drive'}</span>
            </button>
          </div>

          {driveProcessing && (
            <div className="bg-blue-950/35 border border-blue-500/40 rounded-xl px-5 py-3.5 flex items-center gap-3 text-xs text-blue-200">
              <RefreshCw className="w-4 h-4 animate-spin text-blue-400 shrink-0" />
              <span>{driveProgressLabel || 'Processing selected Google Drive files...'}</span>
            </div>
          )}

          {!hasWorkspaceAccess ? (
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-8 text-center space-y-3">
              <p className="text-sm text-slate-200">
                Connect your Google Workspace session to parse Bank Statements, Payslips, and Invoices straight from Google Drive.
              </p>
              <button
                onClick={() => void connectGoogleWorkspace()}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                <Folder className="w-3.5 h-3.5" />
                <span>Connect Gmail &amp; Drive Session</span>
              </button>
            </div>
          ) : driveFiles.length === 0 ? (
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-8 text-center text-xs text-slate-400">
              Click &ldquo;Scan Google Drive&rdquo; to list PDFs, CSVs, and Google Sheets in your Drive, extract Bank Statements &amp; Payslips, and auto-generate Contracts, Subscriptions, Loans, and Expenses.
            </div>
          ) : (
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
              {selectedDriveIds.length > 0 && (
                <div className="px-6 py-3 bg-[#111827] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs font-medium text-slate-200">
                    {selectedDriveIds.length} Drive file{selectedDriveIds.length === 1 ? '' : 's'} selected
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={driveProcessing}
                      onClick={() =>
                        void processDriveFilesAsStatements(
                          driveFiles.filter((f) => selectedDriveIds.includes(f.id))
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Parse Selected as Statements (Discover Subs / Loans / Expenses)</span>
                    </button>
                    <button
                      type="button"
                      disabled={driveProcessing}
                      onClick={() =>
                        void processDriveFilesAsPayslips(
                          driveFiles.filter((f) => selectedDriveIds.includes(f.id))
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-xs font-medium text-white rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <FileSpreadsheet className="w-3.5 h-3.5" />
                      <span>Parse Selected as Payslips (Generate Contracts)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedDriveIds([])}
                      className="px-2.5 py-1.5 bg-[#1E293B] hover:bg-slate-700 text-xs text-slate-300 rounded-lg cursor-pointer"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs text-slate-400">
                      <th className="py-3 pl-5 pr-2 w-8">
                        <input
                          type="checkbox"
                          checked={
                            driveFiles.length > 0 && selectedDriveIds.length === driveFiles.length
                          }
                          onChange={(e) =>
                            setSelectedDriveIds(e.target.checked ? driveFiles.map((f) => f.id) : [])
                          }
                          aria-label="Select all Drive files"
                          className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                        />
                      </th>
                      <th className="py-3 px-4 font-medium">File Name</th>
                      <th className="py-3 px-4 font-medium">Type</th>
                      <th className="py-3 px-4 font-medium">Modified</th>
                      <th className="py-3 px-4 font-medium">Vault Status</th>
                      <th className="py-3 px-6 font-medium text-right">Extract From Drive</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {driveFiles.map((file) => {
                      const existingDoc = filteredInvoiceDocuments.find(
                        (d) => d.driveFileId === file.id
                      );
                      const isChecked = selectedDriveIds.includes(file.id);
                      return (
                        <tr key={file.id} className="hover:bg-slate-800/30">
                          <td className="py-3 pl-5 pr-2">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedDriveIds((prev) => [...prev, file.id]);
                                } else {
                                  setSelectedDriveIds((prev) => prev.filter((id) => id !== file.id));
                                }
                              }}
                              aria-label={`Select ${file.name}`}
                              className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                            />
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              <FileText className="w-4 h-4 text-sky-400 shrink-0" />
                              <span className="font-medium text-slate-100">{file.name}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4 text-xs font-mono text-slate-400">
                            {file.mimeType.includes('spreadsheet')
                              ? 'gsheet'
                              : file.mimeType.split('/')[1] || file.mimeType}
                          </td>
                          <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-400">
                            {file.modifiedTime ? file.modifiedTime.slice(0, 10) : '—'}
                          </td>
                          <td className="py-3 px-4 text-xs">
                            {existingDoc ? (
                              <span className="text-emerald-400 font-mono">
                                {existingDoc.driveFolderPath || 'Registered'}
                              </span>
                            ) : (
                              <span className="text-slate-500">Not indexed</span>
                            )}
                          </td>
                          <td className="py-3 px-6 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              {file.webViewLink && (
                                <a
                                  href={file.webViewLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-1 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs text-slate-200 rounded"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                  <span>View</span>
                                </a>
                              )}
                              <button
                                onClick={() => void processDriveFilesAsStatements([file])}
                                disabled={driveProcessing || Boolean(extractingKey)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 disabled:opacity-50 text-xs font-medium text-sky-300 rounded cursor-pointer whitespace-nowrap shrink-0"
                              >
                                <span>Statement</span>
                              </button>
                              <button
                                onClick={() => void processDriveFilesAsPayslips([file])}
                                disabled={driveProcessing || Boolean(extractingKey)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 disabled:opacity-50 text-xs font-medium text-emerald-300 rounded cursor-pointer whitespace-nowrap shrink-0"
                              >
                                <span>Payslip</span>
                              </button>
                              <button
                                onClick={() => void handleExtractDriveFile(file)}
                                disabled={driveProcessing || Boolean(extractingKey)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white rounded cursor-pointer whitespace-nowrap shrink-0"
                              >
                                <Sparkles className="w-3 h-3" />
                                <span>
                                  {extractingKey === file.id ? 'Extracting...' : 'Invoice'}
                                </span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Auto-Generated Contracts, Payslips, Subscriptions, Loans & Expenses Workbench */}
          {hasGeneratedDrafts && (
            <section className="bg-[#0F172A] border border-blue-500/40 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-800 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                <div>
                  <h3 className="text-base font-semibold text-slate-100">
                    Drive Discovery &amp; Auto-Generation Preview
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Review Contracts, Payslips, Subscriptions, Credit Facilities &amp; Categorized Expenses extracted from Google Drive before writing to Firebase.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <select
                    value={resolvedGenEntityId}
                    onChange={(e) => setGenEntityId(e.target.value)}
                    className="bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100"
                  >
                    {entities.map((ent) => (
                      <option key={ent.id} value={ent.id}>
                        Entity: {ent.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={resolvedGenAccountId}
                    onChange={(e) => setGenAccountId(e.target.value)}
                    className="bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100"
                  >
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        Account: {acc.name} ({entityMap.get(acc.entityId)?.name ?? ''})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => {
                      setGenStatements([]);
                      setGenPayslips([]);
                      setGenContracts([]);
                      setGenSubscriptions([]);
                      setGenFacilities([]);
                    }}
                    className="px-3 py-1.5 bg-[#1E293B] hover:bg-slate-700 text-xs text-slate-300 rounded-lg cursor-pointer"
                  >
                    Discard Drafts
                  </button>
                  <button
                    type="button"
                    disabled={genSaving}
                    onClick={() => void commitDriveWorkbenchToFirebase()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{genSaving ? 'Saving to Firebase...' : 'Save Selected to Firebase'}</span>
                  </button>
                </div>
              </div>

              <div className="px-6 py-3 bg-[#111827] border-b border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs">
                <div className="flex flex-wrap items-center gap-5">
                  <label className="flex items-center gap-2 text-emerald-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={genPreserveBalance}
                      onChange={(e) => setGenPreserveBalance(e.target.checked)}
                      className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                    />
                    <span>Preserve live account balances (historical data)</span>
                  </label>
                  <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={genCreateLedgerTx}
                      onChange={(e) => setGenCreateLedgerTx(e.target.checked)}
                      className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                    />
                    <span>Auto-create &amp; reconcile Ledger Expenses/Income from bank lines</span>
                  </label>
                  <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={genMarkPayslipsPaid}
                      onChange={(e) => setGenMarkPayslipsPaid(e.target.checked)}
                      className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                    />
                    <span>Mark imported payslips already Paid</span>
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-1 bg-[#1E293B] border border-slate-700 rounded-lg p-1">
                  {(
                    [
                      ['contracts', `Contracts (${genContracts.filter((c) => c.selected).length})`],
                      ['payslips', `Payslips (${genPayslips.filter((p) => p.selected).length})`],
                      ['subscriptions', `Subscriptions (${genSubscriptions.filter((s) => s.selected).length})`],
                      ['facilities', `Loans/Credits (${genFacilities.filter((f) => f.selected).length})`],
                      [
                        'expenses',
                        `Statement Lines & Expenses (${genStatements.reduce((acc, s) => acc + (s.selected ? s.lines.filter((l) => l.includeTx).length : 0), 0)})`,
                      ],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setGenWorkbenchTab(id)}
                      className={`px-2.5 py-1 text-xs font-medium rounded cursor-pointer whitespace-nowrap ${
                        genWorkbenchTab === id
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-400 hover:text-slate-100'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-5 overflow-x-auto">
                {genWorkbenchTab === 'contracts' && (
                  genContracts.length === 0 ? (
                    <p className="text-xs text-slate-500 py-6 text-center">
                      No contracts queued yet. Click &ldquo;Payslip&rdquo; on any payslip file in Drive to auto-generate worker contracts.
                    </p>
                  ) : (
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="py-2 pr-3">Include</th>
                          <th className="py-2 px-3">Worker &amp; Role</th>
                          <th className="py-2 px-3">Schedule</th>
                          <th className="py-2 px-3 text-right">Base Monthly</th>
                          <th className="py-2 px-3 text-right">IRS % / SS % / TSU %</th>
                          <th className="py-2 px-3 text-right">Meal / Child Voucher</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/80">
                        {genContracts.map((c, idx) => (
                          <tr key={`${c.workerName}-${idx}`} className="hover:bg-slate-800/30">
                            <td className="py-2.5 pr-3">
                              <input
                                type="checkbox"
                                checked={c.selected}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setGenContracts((prev) =>
                                    prev.map((row, rIdx) => (rIdx === idx ? { ...row, selected: checked } : row))
                                  );
                                }}
                                className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                              />
                            </td>
                            <td className="py-2.5 px-3">
                              <p className="font-medium text-slate-100">
                                {c.workerName} · {c.roleTitle}
                              </p>
                              <p className="text-[11px] text-slate-400">
                                {c.employerName || 'Employer'}
                                {c.isOwnerHint ? ' · Owner Income Link' : ''}
                              </p>
                            </td>
                            <td className="py-2.5 px-3 font-mono text-slate-300">{c.paySchedule}</td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-100">
                              {formatMoney(c.baseGrossMonthly, currencyCode)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                              {c.irsRate.toFixed(1)}% / {c.employeeSsRate}% / {c.employerSsRate}%
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-emerald-400">
                              {c.mealPaymentMethod !== 'none'
                                ? `Meal €${c.mealAllowanceDaily}/d`
                                : 'No meal'}
                              {c.childVoucherMonthly > 0
                                ? ` · Child ${formatMoney(c.childVoucherMonthly, currencyCode)}`
                                : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}

                {genWorkbenchTab === 'payslips' && (
                  genPayslips.length === 0 ? (
                    <p className="text-xs text-slate-500 py-6 text-center">
                      No payslips queued yet. Click &ldquo;Payslip&rdquo; on a Drive file above.
                    </p>
                  ) : (
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="py-2 pr-3">Include</th>
                          <th className="py-2 px-3">Employee &amp; File</th>
                          <th className="py-2 px-3">Pay / Tax Date</th>
                          <th className="py-2 px-3 text-right">Gross Pay</th>
                          <th className="py-2 px-3 text-right">Net + Vouchers</th>
                          <th className="py-2 px-3 text-right">IRS + SS</th>
                          <th className="py-2 px-3 text-right">TSU</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/80">
                        {genPayslips.map((p, idx) => (
                          <tr key={`${p.employeeName}-${idx}`} className="hover:bg-slate-800/30">
                            <td className="py-2.5 pr-3">
                              <input
                                type="checkbox"
                                checked={p.selected}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setGenPayslips((prev) =>
                                    prev.map((row, rIdx) => (rIdx === idx ? { ...row, selected: checked } : row))
                                  );
                                }}
                                className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                              />
                            </td>
                            <td className="py-2.5 px-3">
                              <p className="font-medium text-slate-100">{p.employeeName}</p>
                              <p className="text-[11px] text-slate-400">{p.sourceFilename}</p>
                            </td>
                            <td className="py-2.5 px-3 font-mono tabular-nums text-slate-300">
                              {p.payDate} · Tax {p.taxDueDate}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                              {formatMoney(p.grossPay, currencyCode)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-emerald-400">
                              {formatMoney(p.netPay, currencyCode)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-amber-300">
                              {formatMoney(p.employeeWithholdings, currencyCode)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-200">
                              {formatMoney(p.employerTaxes + p.employerContributions, currencyCode)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}

                {genWorkbenchTab === 'subscriptions' && (
                  genSubscriptions.length === 0 ? (
                    <p className="text-xs text-slate-500 py-6 text-center">
                      No recurring subscriptions detected yet. Select one or more Bank Statements in Drive and click &ldquo;Statement&rdquo;.
                    </p>
                  ) : (
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="py-2 pr-3">Include</th>
                          <th className="py-2 px-3">Service / Vendor</th>
                          <th className="py-2 px-3">Category</th>
                          <th className="py-2 px-3">Cycle</th>
                          <th className="py-2 px-3 text-right">Amount</th>
                          <th className="py-2 px-3 text-right">IVA</th>
                          <th className="py-2 px-3">Detected Notes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/80">
                        {genSubscriptions.map((s, idx) => (
                          <tr key={`${s.vendor}-${idx}`} className="hover:bg-slate-800/30">
                            <td className="py-2.5 pr-3">
                              <input
                                type="checkbox"
                                checked={s.selected}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setGenSubscriptions((prev) =>
                                    prev.map((row, rIdx) => (rIdx === idx ? { ...row, selected: checked } : row))
                                  );
                                }}
                                className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                              />
                            </td>
                            <td className="py-2.5 px-3">
                              <p className="font-medium text-slate-100">{s.name}</p>
                              <p className="text-[11px] text-slate-400">{s.vendor}</p>
                            </td>
                            <td className="py-2.5 px-3 text-slate-300">{s.category}</td>
                            <td className="py-2.5 px-3 font-mono text-slate-300">
                              {s.frequency} · day {s.billingDay}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-100">
                              {formatMoney(s.amount, currencyCode)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                              {s.ivaRate}% {s.ivaDeductible ? '(Ded.)' : ''}
                            </td>
                            <td className="py-2.5 px-3 text-slate-400">
                              {s.notes || `${s.matchCount}x seen`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}

                {genWorkbenchTab === 'facilities' && (
                  genFacilities.length === 0 ? (
                    <p className="text-xs text-slate-500 py-6 text-center">
                      No loan repayments or credit facilities detected in parsed bank statements.
                    </p>
                  ) : (
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="py-2 pr-3">Include</th>
                          <th className="py-2 px-3">Facility Name</th>
                          <th className="py-2 px-3">Lender</th>
                          <th className="py-2 px-3">Type</th>
                          <th className="py-2 px-3 text-right">Monthly Payment</th>
                          <th className="py-2 px-3 text-right">Due Day</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/80">
                        {genFacilities.map((f, idx) => (
                          <tr key={`${f.name}-${idx}`} className="hover:bg-slate-800/30">
                            <td className="py-2.5 pr-3">
                              <input
                                type="checkbox"
                                checked={f.selected}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setGenFacilities((prev) =>
                                    prev.map((row, rIdx) => (rIdx === idx ? { ...row, selected: checked } : row))
                                  );
                                }}
                                className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                              />
                            </td>
                            <td className="py-2.5 px-3 font-medium text-slate-100">{f.name}</td>
                            <td className="py-2.5 px-3 text-slate-300">{f.lender}</td>
                            <td className="py-2.5 px-3 font-mono text-slate-300">{f.facilityType}</td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-amber-300">
                              {formatMoney(f.monthlyPayment, currencyCode)}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono text-slate-300">Day {f.dueDay}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}

                {genWorkbenchTab === 'expenses' && (
                  genStatements.length === 0 ? (
                    <p className="text-xs text-slate-500 py-6 text-center">
                      No bank statements extracted yet.
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {genStatements.map((stmt, sIdx) => (
                        <div key={`${stmt.filename}-${sIdx}`} className="border border-slate-800 rounded-lg overflow-hidden">
                          <div className="px-4 py-2.5 bg-[#111827] border-b border-slate-800 flex items-center justify-between text-xs">
                            <label className="flex items-center gap-2 font-medium text-slate-100 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={stmt.selected}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setGenStatements((prev) =>
                                    prev.map((st, idx) => (idx === sIdx ? { ...st, selected: checked } : st))
                                  );
                                }}
                                className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                              />
                              <span>
                                {stmt.filename} ({stmt.statementPeriod || 'Statement'} · {stmt.lines.length} lines)
                              </span>
                            </label>
                            <span className="font-mono tabular-nums text-slate-400">
                              Close: {formatMoney(stmt.closingBalance, currencyCode)}
                            </span>
                          </div>
                          <div className="max-h-72 overflow-y-auto">
                            <table className="w-full text-left border-collapse text-xs">
                              <thead>
                                <tr className="border-b border-slate-800 text-slate-400">
                                  <th className="py-2 px-3">Tx</th>
                                  <th className="py-2 px-3">Date</th>
                                  <th className="py-2 px-3">Bank Description / Vendor</th>
                                  <th className="py-2 px-3">Category</th>
                                  <th className="py-2 px-3">Type</th>
                                  <th className="py-2 px-3 text-right">Amount</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-800/70">
                                {stmt.lines.map((line, lIdx) => (
                                  <tr key={lIdx} className="hover:bg-slate-800/30">
                                    <td className="py-2 px-3">
                                      <input
                                        type="checkbox"
                                        checked={line.includeTx}
                                        disabled={!genCreateLedgerTx}
                                        onChange={(e) => {
                                          const checked = e.target.checked;
                                          setGenStatements((prev) =>
                                            prev.map((st, idx) =>
                                              idx !== sIdx
                                                ? st
                                                : {
                                                    ...st,
                                                    lines: st.lines.map((row, rIdx) =>
                                                      rIdx === lIdx ? { ...row, includeTx: checked } : row
                                                    ),
                                                  }
                                            )
                                          );
                                        }}
                                        className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                                      />
                                    </td>
                                    <td className="py-2 px-3 font-mono tabular-nums text-slate-400">
                                      {line.date}
                                    </td>
                                    <td className="py-2 px-3">
                                      <p className="text-slate-100 font-medium">
                                        {line.vendor ? `${line.vendor} · ` : ''}
                                        {line.description}
                                      </p>
                                    </td>
                                    <td className="py-2 px-3 text-slate-300">{line.category}</td>
                                    <td className="py-2 px-3 font-mono text-slate-400">{line.type}</td>
                                    <td
                                      className={`py-2 px-3 text-right font-mono tabular-nums font-medium ${
                                        line.direction === 'credit' ? 'text-emerald-400' : 'text-slate-100'
                                      }`}
                                    >
                                      {line.direction === 'credit' ? '+' : '-'}
                                      {formatMoney(line.amount, currencyCode)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
            </section>
          )}
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 3: HISTORICAL BATCH IMPORT (2025)                                 */}
      {/* ===================================================================== */}
      {activeTab === 'historical' && (
        <div className="space-y-6">
          <input
            ref={histStmtRef}
            type="file"
            multiple
            accept=".csv,.txt,.pdf,.png,.jpg,.jpeg,.webp"
            onChange={handleHistStatementsSelect}
            className="hidden"
          />
          <input
            ref={histInvRef}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.webp"
            onChange={handleHistInvoicesSelect}
            className="hidden"
          />
          <input
            ref={histPayRef}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.webp"
            onChange={handleHistPayslipsSelect}
            className="hidden"
          />

          {/* Historical Checklist & Safety Controls */}
          <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  2025 Historical Documentation Backfill
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Need: (1) Bank statement CSVs/PDFs per account, (2) Supplier &amp; SaaS invoice PDFs (or scan Gmail 2025), (3) 2025 monthly payslips for IRC/IRS history.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={resolvedHistEntityId}
                  onChange={(e) => setHistEntityId(e.target.value)}
                  className="bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                >
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      Entity: {ent.name}
                    </option>
                  ))}
                </select>
                <select
                  value={resolvedHistAccountId}
                  onChange={(e) => setHistAccountId(e.target.value)}
                  className="bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                >
                  {accounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      Account: {acc.name} ({entityMap.get(acc.entityId)?.name ?? ''})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-6 pt-3 border-t border-slate-800 text-xs">
              <label className="flex items-center gap-2 text-emerald-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={histPreserveBalance}
                  onChange={(e) => setHistPreserveBalance(e.target.checked)}
                  className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                />
                <span>
                  Historical Mode — preserve current live account balances (recommended for last year&apos;s data)
                </span>
              </label>

              <label className="flex items-center gap-2 text-sky-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={histUseLocalCsv}
                  onChange={(e) => setHistUseLocalCsv(e.target.checked)}
                  className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                />
                <span>Local CSV Parser (Zero-AI, browser-only for .csv bank exports)</span>
              </label>
            </div>
          </div>

          {/* 3-Column Batch Drop/Select Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* 1. Statements */}
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-slate-100">1. Bank Statements</h4>
                <p className="text-xs text-slate-400 mt-1">
                  Multi-select CSV, PDF, or images from 2025. CSVs stay 100% in your browser when Zero-AI mode is enabled.
                </p>
              </div>
              <div className="space-y-2">
                <button
                  onClick={() => histStmtRef.current?.click()}
                  disabled={histParsing}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>{histParsing ? 'Parsing...' : 'Select Statement Files'}</span>
                </button>
                {histStatements.length > 0 && (
                  <button
                    onClick={() => void commitHistStatements()}
                    disabled={histImporting}
                    className="w-full px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
                  >
                    Import {histStatements.length} Statement(s) (
                    {histStatements.reduce((s, d) => s + d.lines.length, 0)} lines)
                  </button>
                )}
              </div>
            </div>

            {/* 2. Invoices */}
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-slate-100">2. Supplier Invoices (PDF/Img)</h4>
                <p className="text-xs text-slate-400 mt-1">
                  Extract NIF, invoice number, IVA rate, and total. Auto-matches against imported bank statement lines.
                </p>
              </div>
              <div className="space-y-2">
                <button
                  onClick={() => histInvRef.current?.click()}
                  disabled={histParsing}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>{histParsing ? 'Extracting...' : 'Select Invoice PDFs'}</span>
                </button>
                {histInvoices.length > 0 && (
                  <div className="flex gap-2">
                    {hasWorkspaceAccess && (
                      <button
                        onClick={() =>
                          setDriveConfirm({
                            mode: 'batch',
                            items: histInvoices,
                            rootFolderId,
                            rootFolderName: rootFolderName || 'Strata Treasury',
                            docCategory: 'Invoices',
                          })
                        }
                        className="flex-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white rounded-lg cursor-pointer"
                      >
                        File {histInvoices.length} to Drive
                      </button>
                    )}
                    <button
                      onClick={() => void commitHistInvoicesLocally()}
                      disabled={histImporting}
                      className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
                    >
                      Save Ledger Only
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* 3. Payslips */}
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4">
              <div>
                <h4 className="text-sm font-semibold text-slate-100">3. Historical Payslips</h4>
                <p className="text-xs text-slate-400 mt-1">
                  Upload 2025 salary receipts to reconstruct payroll employer cost for 2025 IRC &amp; IRS baseline.
                </p>
              </div>
              <div className="space-y-2">
                <button
                  onClick={() => histPayRef.current?.click()}
                  disabled={histParsing}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>{histParsing ? 'Parsing...' : 'Select Payslip PDFs'}</span>
                </button>
                {histPayslips.length > 0 && (
                  <button
                    onClick={() => void commitHistPayslips()}
                    disabled={histImporting}
                    className="w-full px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg cursor-pointer"
                  >
                    Import {histPayslips.length} Historical Payslip(s)
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Staged Preview Tables */}
          {histStatements.length > 0 && (
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-100">
                  Staged Bank Statements ({histStatements.length})
                </h4>
                <button
                  onClick={() => setHistStatements([])}
                  className="text-xs text-slate-400 hover:text-rose-400 cursor-pointer"
                >
                  Clear queue
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {histStatements.map((s, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-[#1E293B]/60 border border-slate-800 rounded-lg flex items-center justify-between text-xs"
                  >
                    <div>
                      <p className="font-medium text-slate-100">{s.filename}</p>
                      <p className="text-slate-400 font-mono tabular-nums mt-0.5">
                        {s.statementPeriod} · {s.lines.length} lines
                      </p>
                    </div>
                    <button
                      onClick={() =>
                        setHistStatements((prev) => prev.filter((_, i) => i !== idx))
                      }
                      className="text-slate-500 hover:text-rose-400 p-1 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {histInvoices.length > 0 && (
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-6 py-3.5 border-b border-slate-800 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-100">
                  Staged Historical Invoices ({histInvoices.length})
                </h4>
                <button
                  onClick={() => setHistInvoices([])}
                  className="text-xs text-slate-400 hover:text-rose-400 cursor-pointer"
                >
                  Clear queue
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="py-2.5 px-6 font-medium">Date</th>
                      <th className="py-2.5 px-4 font-medium">Vendor &amp; File</th>
                      <th className="py-2.5 px-4 font-medium">Invoice #</th>
                      <th className="py-2.5 px-4 font-medium">Entity</th>
                      <th className="py-2.5 px-4 font-medium text-right">Amount</th>
                      <th className="py-2.5 px-6 font-medium text-right">Remove</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {histInvoices.map((inv, idx) => (
                      <tr key={idx}>
                        <td className="py-2.5 px-6 font-mono text-slate-300">{inv.date}</td>
                        <td className="py-2.5 px-4">
                          <p className="font-medium text-slate-100">{inv.vendor}</p>
                          <p className="text-slate-400">{inv.filename}</p>
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-300">
                          {inv.invoiceNumber || '—'}
                        </td>
                        <td className="py-2.5 px-4 text-slate-300">
                          {entityMap.get(inv.entityId)?.name ?? 'Entity'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-100">
                          {formatMoney(inv.amount, currencyCode)}
                        </td>
                        <td className="py-2.5 px-6 text-right">
                          <button
                            onClick={() =>
                              setHistInvoices((prev) => prev.filter((_, i) => i !== idx))
                            }
                            className="text-slate-500 hover:text-rose-400 p-1 cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {histPayslips.length > 0 && (
            <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-100">
                  Staged Historical Payslips ({histPayslips.length})
                </h4>
                <button
                  onClick={() => setHistPayslips([])}
                  className="text-xs text-slate-400 hover:text-rose-400 cursor-pointer"
                >
                  Clear queue
                </button>
              </div>
              <div className="divide-y divide-slate-800 text-xs">
                {histPayslips.map((p, idx) => (
                  <div key={idx} className="py-2.5 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium text-slate-100">{p.employeeName}</p>
                      <p className="text-slate-400 font-mono">
                        Pay Date {p.payDate} · {p.sourceFilename}
                      </p>
                    </div>
                    <div className="flex items-center gap-4 font-mono tabular-nums">
                      <span className="text-slate-300">
                        Gross {formatMoney(p.grossPay, currencyCode)}
                      </span>
                      <span className="text-emerald-400">
                        Net {formatMoney(p.netPay, currencyCode)}
                      </span>
                      <button
                        onClick={() =>
                          setHistPayslips((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="text-slate-500 hover:text-rose-400 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 4: INVOICE VAULT & RECONCILED DRIVE LINKS                         */}
      {/* ===================================================================== */}
      {activeTab === 'vault' && (
        <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-base font-semibold text-slate-100">
                Invoice Vault &amp; Drive Links
              </h3>
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search vendor, fatura #, folder..."
                  value={vaultSearch}
                  onChange={(e) => setVaultSearch(e.target.value)}
                  className="bg-[#1E293B] border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-100 w-60 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1 p-1 bg-[#1E293B] border border-slate-700 rounded-lg">
              {(
                [
                  ['all', `All (${vaultStats.total})`],
                  ['reconciled', `Reconciled (${vaultStats.reconciled})`],
                  ['filed', `Filed in Drive`],
                  ['inbox', `Unlinked (${vaultStats.inbox})`],
                ] as Array<[typeof vaultFilter, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setVaultFilter(id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded whitespace-nowrap cursor-pointer ${
                    vaultFilter === id
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {visibleVaultDocs.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-400">
              No invoice documents match this filter yet. Scan Gmail, organize existing Drive PDFs, or upload historical invoices to populate the vault.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs text-slate-400">
                    <th className="py-3 px-6 font-medium">Date</th>
                    <th className="py-3 px-4 font-medium">Vendor &amp; NIF</th>
                    <th className="py-3 px-4 font-medium">Invoice # &amp; Entity</th>
                    <th className="py-3 px-4 font-medium text-right">Amount &amp; IVA</th>
                    <th className="py-3 px-4 font-medium">Google Drive Folder &amp; PDF</th>
                    <th className="py-3 px-4 font-medium">Bank Reconciliation</th>
                    <th className="py-3 px-6 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {visibleVaultDocs.map((docItem) => {
                    const ent = entityMap.get(docItem.entityId);
                    const stmtLine = docItem.statementLineId
                      ? lineMap.get(docItem.statementLineId)
                      : undefined;
                    return (
                      <tr key={docItem.id} className="hover:bg-slate-800/30">
                        <td className="py-3.5 px-6 text-xs font-mono tabular-nums text-slate-400 whitespace-nowrap">
                          {docItem.date}
                        </td>
                        <td className="py-3.5 px-4">
                          <p className="font-medium text-slate-100">{docItem.vendor}</p>
                          <p className="text-xs font-mono text-slate-400 mt-0.5">
                            {docItem.vendorNif ? `NIF ${docItem.vendorNif}` : docItem.filename}
                          </p>
                        </td>
                        <td className="py-3.5 px-4 text-xs">
                          <p className="font-mono text-slate-200">
                            {docItem.invoiceNumber || 'No reference'}
                          </p>
                          <p className="text-slate-400 mt-0.5">{ent?.name ?? 'Entity'}</p>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                          <p className="font-semibold text-slate-100">
                            {formatMoney(docItem.amount, currencyCode)}
                          </p>
                          <p className="text-[11px] text-slate-400 mt-0.5">
                            {docItem.ivaRate > 0
                              ? `IVA ${docItem.ivaRate}% (${formatMoney(docItem.ivaAmount, currencyCode)})`
                              : 'IVA 0%'}
                          </p>
                        </td>
                        <td className="py-3.5 px-4 text-xs">
                          {docItem.driveWebViewLink ? (
                            <div className="space-y-1">
                              <p className="font-mono text-slate-300 truncate max-w-[240px]">
                                {docItem.driveFolderPath || 'Google Drive'}
                              </p>
                              <a
                                href={docItem.driveWebViewLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 font-medium"
                              >
                                <ExternalLink className="w-3 h-3" />
                                <span>Open Invoice PDF</span>
                              </a>
                            </div>
                          ) : (
                            <span className="text-slate-500">Not uploaded to Drive</span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-xs">
                          {docItem.status === 'reconciled' || stmtLine ? (
                            <div className="space-y-0.5">
                              <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                Reconciled
                              </span>
                              {stmtLine && (
                                <p className="text-slate-400 truncate max-w-[180px]">
                                  {stmtLine.date} · {stmtLine.description}
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-amber-300">
                              <AlertCircle className="w-3.5 h-3.5" />
                              Awaiting bank match
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-6 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-2">
                            {docItem.status !== 'reconciled' && (
                              <>
                                <button
                                  onClick={() => setMatchingVaultDoc(docItem)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#1E293B] hover:bg-blue-600 border border-slate-700 hover:border-blue-500 text-xs font-medium text-slate-100 rounded cursor-pointer"
                                >
                                  <Link2 className="w-3 h-3" />
                                  <span>Match Bank Line</span>
                                </button>
                                <button
                                  onClick={() => void deleteInvoiceDocument(docItem.id)}
                                  aria-label={`Delete ${docItem.filename}`}
                                  className="text-slate-500 hover:text-rose-400 p-1 cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ===================================================================== */}
      {/* MODAL 1: REVIEW EXTRACTED INVOICE BEFORE FILING TO DRIVE & LEDGER     */}
      {/* ===================================================================== */}
      {reviewItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setReviewItem(null)} />
          <div className="relative z-10 max-w-2xl w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  Review Extracted Invoice &amp; Filing Destination
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Source file: {reviewItem.filename}
                  {reviewItem.notes ? ` · ${reviewItem.notes}` : ''}
                </p>
              </div>
              <button
                onClick={() => setReviewItem(null)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Vendor</label>
                <input
                  type="text"
                  value={reviewItem.vendor}
                  onChange={(e) => setReviewItem({ ...reviewItem, vendor: e.target.value })}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Vendor NIF / Tax ID</label>
                <input
                  type="text"
                  value={reviewItem.vendorNif}
                  onChange={(e) => setReviewItem({ ...reviewItem, vendorNif: e.target.value })}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Invoice / Fatura #</label>
                <input
                  type="text"
                  value={reviewItem.invoiceNumber}
                  onChange={(e) =>
                    setReviewItem({ ...reviewItem, invoiceNumber: e.target.value })
                  }
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Date</label>
                <input
                  type="date"
                  value={reviewItem.date}
                  onChange={(e) => setReviewItem({ ...reviewItem, date: e.target.value })}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Gross Total</label>
                <input
                  type="number"
                  step="0.01"
                  value={reviewItem.amount}
                  onChange={(e) => {
                    const amt = Math.max(0, Number(e.target.value) || 0);
                    setReviewItem({
                      ...reviewItem,
                      amount: amt,
                      ivaAmount: computeTransactionIva(amt, reviewItem.ivaRate),
                    });
                  }}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">IVA Rate (%)</label>
                <input
                  type="number"
                  step="1"
                  min="0"
                  max="30"
                  value={reviewItem.ivaRate}
                  onChange={(e) => {
                    const rate = Math.min(30, Math.max(0, Number(e.target.value) || 0));
                    setReviewItem({
                      ...reviewItem,
                      ivaRate: rate,
                      ivaAmount: computeTransactionIva(reviewItem.amount, rate),
                    });
                  }}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">IVA Amount</label>
                <input
                  type="number"
                  step="0.01"
                  value={reviewItem.ivaAmount}
                  onChange={(e) =>
                    setReviewItem({
                      ...reviewItem,
                      ivaAmount: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Target Entity (Invoice Owner &amp; Drive Subfolder)
                </label>
                <select
                  value={reviewItem.entityId}
                  onChange={(e) => {
                    const entId = e.target.value;
                    const acc = accounts.find((a) => a.entityId === entId) ?? accounts[0];
                    setReviewItem({
                      ...reviewItem,
                      entityId: entId,
                      accountId: acc?.id || '',
                    });
                  }}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                >
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.name} ({ent.entityType})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Paid From Account
                </label>
                <select
                  value={reviewItem.accountId}
                  onChange={(e) => {
                    const acc = accountMap.get(e.target.value);
                    const isCross = Boolean(acc && acc.entityId !== reviewItem.entityId);
                    setReviewItem({
                      ...reviewItem,
                      accountId: e.target.value,
                      isCrossEntityReimb: isCross,
                      paidByEntityId: acc?.entityId || '',
                    });
                  }}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {entityMap.get(a.entityId)?.name ?? 'Entity'}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Category</label>
                <input
                  type="text"
                  value={reviewItem.category}
                  onChange={(e) => setReviewItem({ ...reviewItem, category: e.target.value })}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">
                  Match Bank Statement Line (Optional)
                </label>
                <select
                  value={reviewItem.matchedStatementLineId}
                  onChange={(e) =>
                    setReviewItem({ ...reviewItem, matchedStatementLineId: e.target.value })
                  }
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                >
                  <option value="">Leave unmatched for now</option>
                  {candidateStatementMatchesForReview.map((m) => (
                    <option key={m.line.id} value={m.line.id}>
                      Suggested ({Math.round(m.score * 100)}%): {m.line.date} · {m.line.description} ({formatMoney(m.line.amount, currencyCode)})
                    </option>
                  ))}
                  {statementLines
                    .filter(
                      (l) =>
                        l.reconciliationStatus !== 'reconciled' &&
                        !candidateStatementMatchesForReview.some((m) => m.line.id === l.id)
                    )
                    .slice(0, 25)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.date} · {l.description} ({formatMoney(l.amount, currencyCode)})
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <div className="p-3 bg-[#1E293B]/60 border border-slate-800 rounded-lg space-y-2 text-xs">
              <p className="text-slate-300">
                Google Drive Target Folder:{' '}
                <span className="font-mono text-sky-300">
                  {rootFolderName || 'Strata Treasury'} /{' '}
                  {entityMap.get(reviewItem.entityId)?.name ?? 'Entity'} /{' '}
                  {reviewItem.date.slice(0, 4)} / Invoices
                </span>
              </p>
              <label className="flex items-center gap-2 text-emerald-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reviewItem.ivaDeductible}
                  onChange={(e) =>
                    setReviewItem({ ...reviewItem, ivaDeductible: e.target.checked })
                  }
                  className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                />
                <span>IVA Dedutível (company deductible input VAT)</span>
              </label>
              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reviewItem.historicalPreserveBalance}
                  onChange={(e) =>
                    setReviewItem({
                      ...reviewItem,
                      historicalPreserveBalance: e.target.checked,
                    })
                  }
                  className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                />
                <span>Historical entry — preserve current live account balance</span>
              </label>
              {reviewItem.isCrossEntityReimb && (
                <p className="text-amber-300">
                  Paid by {entityMap.get(reviewItem.paidByEntityId)?.name}: will also open an inter-entity reimbursement claim.
                </p>
              )}
            </div>

            <div className="pt-2 border-t border-slate-800 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                onClick={() => setReviewItem(null)}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const matchedLine = reviewItem.matchedStatementLineId
                    ? lineMap.get(reviewItem.matchedStatementLineId)
                    : undefined;
                  await createLedgerAndFileInvoice({
                    invoiceInput: {
                      entityId: reviewItem.entityId,
                      accountId: reviewItem.accountId,
                      transactionId: '',
                      statementLineId: matchedLine?.id || '',
                      reimbursementId: '',
                      source: reviewItem.source,
                      vendor: reviewItem.vendor,
                      vendorNif: reviewItem.vendorNif,
                      invoiceNumber: reviewItem.invoiceNumber,
                      date: reviewItem.date,
                      amount: reviewItem.amount,
                      ivaRate: reviewItem.ivaRate,
                      ivaAmount: reviewItem.ivaAmount,
                      ivaDeductible: reviewItem.ivaDeductible,
                      filename: reviewItem.filename,
                      driveFileId: reviewItem.existingDriveFileId,
                      driveWebViewLink: reviewItem.existingDriveWebViewLink,
                      driveFolderId: '',
                      driveFolderPath: reviewItem.existingDriveFileId ? 'Existing Drive Location' : '',
                      gmailMessageId: reviewItem.gmailMessageId,
                      status: matchedLine ? 'reconciled' : 'inbox',
                    },
                    accountId: reviewItem.accountId,
                    category: reviewItem.category,
                    description: reviewItem.description,
                    createReimbursementToEntityId: reviewItem.isCrossEntityReimb
                      ? reviewItem.paidByEntityId
                      : undefined,
                    adjustAccountBalance: !reviewItem.historicalPreserveBalance,
                    matchedStatementLine: matchedLine,
                  });
                  setReviewItem(null);
                }}
                className="px-4 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg cursor-pointer"
              >
                Save to Ledger Only (Skip Drive)
              </button>
              <button
                type="button"
                disabled={!hasWorkspaceAccess}
                onClick={() =>
                  setDriveConfirm({
                    mode: 'single',
                    items: [reviewItem],
                    rootFolderId,
                    rootFolderName: rootFolderName || 'Strata Treasury',
                    docCategory: 'Invoices',
                  })
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                <FolderInput className="w-3.5 h-3.5" />
                <span>
                  {reviewItem.existingDriveFileId
                    ? 'Move in Drive & Save Ledger'
                    : 'Upload PDF to Drive & Save'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* MODAL 2: MANDATORY GOOGLE DRIVE WRITE/MOVE CONFIRMATION DIALOG        */}
      {/* ===================================================================== */}
      {driveConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-black/80"
            onClick={() => !executingDrive && setDriveConfirm(null)}
          />
          <div className="relative z-10 max-w-lg w-full bg-[#0F172A] border border-slate-700 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">
                Confirm Google Drive Filing
              </h3>
              <button
                disabled={executingDrive}
                onClick={() => setDriveConfirm(null)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-xs text-slate-300 space-y-2">
              <p>
                You are about to {driveConfirm.items.some((i) => i.existingDriveFileId) ? 'organize/upload' : 'upload'}{' '}
                <strong className="text-slate-100 font-mono">
                  {driveConfirm.items.length} file{driveConfirm.items.length === 1 ? '' : 's'}
                </strong>{' '}
                into your Google Drive under:
              </p>
              <div className="p-3 bg-[#1E293B] border border-slate-700 rounded-lg font-mono text-sky-300 space-y-1 max-h-48 overflow-y-auto">
                {driveConfirm.items.map((item, idx) => {
                  const entName = entityMap.get(item.entityId)?.name ?? 'General';
                  const yr = item.date.slice(0, 4) || '2026';
                  return (
                    <div key={idx} className="text-[11px] leading-relaxed">
                      <span className="text-slate-200">{item.filename}</span> →{' '}
                      <span>
                        {driveConfirm.rootFolderName} / {entName} / {yr} / {driveConfirm.docCategory}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="text-slate-400">
                Missing entity/year subfolders will be created automatically in Google Drive, and the clickable PDF link will be saved to your Strata Treasury ledger.
              </p>
            </div>

            <div className="pt-2 border-t border-slate-800 flex justify-end gap-3">
              <button
                type="button"
                disabled={executingDrive}
                onClick={() => setDriveConfirm(null)}
                className="px-4 py-2 bg-[#1E293B] text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={executingDrive}
                onClick={() => void executeConfirmedDriveFiling()}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {executingDrive
                  ? 'Filing to Drive...'
                  : `Confirm & File ${driveConfirm.items.length} Invoice${driveConfirm.items.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* MODAL 3: MATCH VAULT INVOICE TO BANK STATEMENT LINE                  */}
      {/* ===================================================================== */}
      {matchingVaultDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/75" onClick={() => setMatchingVaultDoc(null)} />
          <div className="relative z-10 max-w-2xl w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3 shrink-0">
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  Match Invoice to Bank Statement Line
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {matchingVaultDoc.vendor} · {matchingVaultDoc.date} ·{' '}
                  <span className="font-mono text-slate-200">
                    {formatMoney(matchingVaultDoc.amount, currencyCode)}
                  </span>
                </p>
              </div>
              <button
                onClick={() => setMatchingVaultDoc(null)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-800/80 border border-slate-800 rounded-lg">
              {unlinkedStatementLinesForVault.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  No bank statement lines found for {entityMap.get(matchingVaultDoc.entityId)?.name ?? 'this entity'}. Import a bank statement first.
                </div>
              ) : (
                unlinkedStatementLinesForVault.map(({ line, score }) => (
                  <div
                    key={line.id}
                    className="p-3.5 flex items-center justify-between gap-4 hover:bg-slate-800/35"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-slate-400">{line.date}</span>
                        <span className="text-xs font-medium text-slate-100 truncate">
                          {line.description}
                        </span>
                        {score > 0 && (
                          <span className="text-[11px] font-mono text-emerald-400">
                            {Math.round(score * 100)}% match
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        {accountMap.get(line.accountId)?.name ?? 'Account'} · Status: {line.reconciliationStatus}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs font-mono tabular-nums text-slate-100">
                        {formatMoney(line.amount, currencyCode)}
                      </span>
                      <button
                        onClick={async () => {
                          await attachInvoiceToRecords({
                            invoiceDoc: matchingVaultDoc,
                            statementLineId: line.id,
                            transactionId: line.matchedTransactionId || matchingVaultDoc.transactionId,
                          });
                          setMatchingVaultDoc(null);
                        }}
                        className="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded cursor-pointer"
                      >
                        Link &amp; Reconcile
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
