import { apiFetch } from '../lib/api';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileSpreadsheet,
  Pencil,
  Plus,
  Trash2,
  Upload,
  UserCheck,
  X,
} from 'lucide-react';
import { useTreasury } from '../contexts/TreasuryContext';
import {
  addVersion,
  isMonthKey,
  monthLabel,
  removeVersion,
  sortedVersions,
  START_MONTH,
  termsAt,
  termsOf,
  versionAt,
  withVersions,
} from '../utils/contractVersions';
import type {
  ContractPaySchedule,
  EmploymentContract,
  MealPaymentMethod,
  ParsedPayslipDraft,
} from '../types/finance';
import {
  addMonths,
  buildCalendarEvents,
  computeContractAnnualTotals,
  computeContractMonthlyBreakdown,
  currentMonthKey,
  formatMoney,
  formatMonthLabel,
  getLastWorkableDayOfMonth,
  getNextMonthTaxDueDate,
  getWorkingDaysInMonth,
  PT_MEAL_EXEMPT_CARD,
  PT_MEAL_EXEMPT_CASH,
  readUploadPayload,
  todayIsoDate,
} from '../utils/financeMath';

interface PayslipCalendarViewProps {
  createModalOpen: boolean;
  onCloseCreateModal: () => void;
  onOpenCreateModal: () => void;
  initialTab?: 'calendar' | 'annual' | 'contracts';
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function PayslipCalendarView({
  createModalOpen,
  onCloseCreateModal,
  onOpenCreateModal,
  initialTab,
}: PayslipCalendarViewProps) {
  const {
    entities,
    accounts,
    payslips,
    filteredPayslips,
    filteredFacilities,
    filteredTransactions,
    filteredRecurringExpenses,
    filteredEmploymentContracts,
    employmentContracts,
    currencyCode,
    entityFilter,
    addPayslip,
    markPayslipStatus,
    deletePayslip,
    addEmploymentContract,
    updateEmploymentContract,
    toggleEmploymentContract,
    deleteEmploymentContract,
    generatePayslipsFromContracts,
    importNoisysourceUploadedPayslips,
    pushToast,
  } = useTreasury();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [viewMode, setViewMode] = useState<'calendar' | 'annual' | 'contracts'>(
    initialTab ?? 'calendar'
  );
  useEffect(() => {
    if (initialTab) setViewMode(initialTab);
  }, [initialTab]);

  const [monthKey, setMonthKey] = useState<string>(currentMonthKey());
  const [selectedDate, setSelectedDate] = useState<string>(todayIsoDate());
  const [parsing, setParsing] = useState(false);
  const [generating, setGenerating] = useState(false);

  const companyEntities = useMemo(() => {
    const list = entities.filter((e) => e.entityType === 'company');
    return list.length > 0 ? list : entities;
  }, [entities]);

  const personalEntities = useMemo(
    () => entities.filter((e) => e.entityType === 'personal'),
    [entities]
  );

  // Payslip Draft Form State (shared by manual entry & AI review)
  const defaultEntityId = entityFilter !== 'all' ? entityFilter : companyEntities[0]?.id ?? '';
  const [formEntityId, setFormEntityId] = useState(defaultEntityId);
  const [employeeName, setEmployeeName] = useState('');
  const [periodStart, setPeriodStart] = useState(`${currentMonthKey()}-01`);
  const [periodEnd, setPeriodEnd] = useState(`${currentMonthKey()}-28`);
  const [payDate, setPayDate] = useState(getLastWorkableDayOfMonth(currentMonthKey()));
  const [taxDueDate, setTaxDueDate] = useState(getNextMonthTaxDueDate(currentMonthKey(), 20));
  const [grossPay, setGrossPay] = useState('3200');
  const [netPay, setNetPay] = useState('2160');
  const [employeeWithholdings, setEmployeeWithholdings] = useState('1040');
  const [employerTaxes, setEmployerTaxes] = useState('760');
  const [employerContributions, setEmployerContributions] = useState('220');
  const [sourceFilename, setSourceFilename] = useState('');
  const [aiNotes, setAiNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Batch multi-employee payslip upload modal state
  const [batchItems, setBatchItems] = useState<Array<ParsedPayslipDraft & { selected: boolean }>>([]);
  const [batchEntityId, setBatchEntityId] = useState(defaultEntityId);
  const [batchFilename, setBatchFilename] = useState('');
  const [batchMarkPaid, setBatchMarkPaid] = useState(false);
  const [savingBatch, setSavingBatch] = useState(false);
  const [importingNoisysource, setImportingNoisysource] = useState(false);

  const importedNoisysourceCount = useMemo(() => {
    const ids = new Set([
      'pay_ns_2025_12_renato',
      'pay_ns_2025_12_marisa',
      'pay_ns_2025_12_bernardo',
      'pay_ns_2026_01_renato',
      'pay_ns_2026_01_marisa',
      'pay_ns_2026_01_bernardo',
    ]);
    return payslips.filter(
      (p) =>
        ids.has(p.id) ||
        p.sourceFilename === '517010585_RC_2025_M12P1_F_82845ab9.pdf' ||
        p.sourceFilename === '517010585_RC_2026_M01P1_F_f214f177.pdf'
    ).length;
  }, [payslips]);

  // Employment Contract Modal State
  const [contractModalOpen, setContractModalOpen] = useState(false);
  const [editingContract, setEditingContract] = useState<EmploymentContract | null>(null);
  const [ctrEntityId, setCtrEntityId] = useState(defaultEntityId);
  const [ctrFundingAccountId, setCtrFundingAccountId] = useState('');
  const [ctrWorkerName, setCtrWorkerName] = useState('');
  const [ctrRoleTitle, setCtrRoleTitle] = useState('');
  const [ctrIsOwner, setCtrIsOwner] = useState(false);
  const [ctrPersonalEntityId, setCtrPersonalEntityId] = useState(personalEntities[0]?.id ?? '');
  const [ctrSchedule, setCtrSchedule] = useState<ContractPaySchedule>('14_months');
  const [ctrBaseGross, setCtrBaseGross] = useState('2500');
  const [ctrIrsRate, setCtrIrsRate] = useState('18.5');
  const [ctrEmpSsRate, setCtrEmpSsRate] = useState('11');
  const [ctrErSsRate, setCtrErSsRate] = useState('23.75');
  const [ctrMealMethod, setCtrMealMethod] = useState<MealPaymentMethod>('card');
  const [ctrMealDaily, setCtrMealDaily] = useState('10.46');
  const [ctrChildMonthly, setCtrChildMonthly] = useState('0');
  const [ctrChildIrs, setCtrChildIrs] = useState(false);
  const [ctrChildSs, setCtrChildSs] = useState(false);
  const [ctrOtherName, setCtrOtherName] = useState('');
  const [ctrOtherMonthly, setCtrOtherMonthly] = useState('0');
  const [ctrOtherIrs, setCtrOtherIrs] = useState(false);
  const [ctrOtherSs, setCtrOtherSs] = useState(false);
  const [savingContract, setSavingContract] = useState(false);
  // Versions: an edit is a change from a month on ("from"), or a fix to the latest terms ("fix").
  const [ctrChange, setCtrChange] = useState<'from' | 'fix'>('from');
  const [ctrFrom, setCtrFrom] = useState(monthKey);
  const [ctrNote, setCtrNote] = useState('');
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);

  const entityMap = useMemo(() => new Map(entities.map((e) => [e.id, e.name])), [entities]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  const monthLastWorkday = useMemo(() => getLastWorkableDayOfMonth(monthKey), [monthKey]);
  const monthWorkDays = useMemo(() => getWorkingDaysInMonth(monthKey), [monthKey]);
  const monthTaxDueNext = useMemo(() => getNextMonthTaxDueDate(monthKey, 20), [monthKey]);

  const ctrEntityAccounts = useMemo(() => {
    const target = ctrEntityId || defaultEntityId;
    const list = accounts.filter((a) => a.entityId === target);
    return list.length > 0 ? list : accounts;
  }, [accounts, ctrEntityId, defaultEntityId]);

  const contractDraftPreview = useMemo(() => {
    const draft: EmploymentContract = {
      id: 'preview',
      userId: '',
      entityId: ctrEntityId || defaultEntityId,
      fundingAccountId: ctrFundingAccountId,
      workerName: ctrWorkerName || 'Worker',
      roleTitle: ctrRoleTitle || 'Role',
      isOwnerIncome: ctrIsOwner,
      personalEntityId: ctrPersonalEntityId,
      paySchedule: ctrSchedule,
      baseGrossMonthly: Math.max(0, Number(ctrBaseGross) || 0),
      irsRate: Math.min(100, Math.max(0, Number(ctrIrsRate) || 0)),
      employeeSsRate: Math.min(100, Math.max(0, Number(ctrEmpSsRate) || 0)),
      employerSsRate: Math.min(100, Math.max(0, Number(ctrErSsRate) || 0)),
      mealAllowanceDaily: Math.max(0, Number(ctrMealDaily) || 0),
      mealPaymentMethod: ctrMealMethod,
      childVoucherMonthly: Math.max(0, Number(ctrChildMonthly) || 0),
      childVoucherSubjectToIrs: ctrChildIrs,
      childVoucherSubjectToSs: ctrChildSs,
      otherBenefitName: ctrOtherName,
      otherBenefitMonthly: Math.max(0, Number(ctrOtherMonthly) || 0),
      otherBenefitSubjectToIrs: ctrOtherIrs,
      otherBenefitSubjectToSs: ctrOtherSs,
      active: true,
    };
    return computeContractMonthlyBreakdown(draft, monthKey);
  }, [
    ctrEntityId,
    defaultEntityId,
    ctrFundingAccountId,
    ctrWorkerName,
    ctrRoleTitle,
    ctrIsOwner,
    ctrPersonalEntityId,
    ctrSchedule,
    ctrBaseGross,
    ctrIrsRate,
    ctrEmpSsRate,
    ctrErSsRate,
    ctrMealDaily,
    ctrMealMethod,
    ctrChildMonthly,
    ctrChildIrs,
    ctrChildSs,
    ctrOtherName,
    ctrOtherMonthly,
    ctrOtherIrs,
    ctrOtherSs,
    monthKey,
  ]);

  const calculatedTotalCost =
    (Number(netPay) || 0) +
    (Number(employeeWithholdings) || 0) +
    (Number(employerTaxes) || 0) +
    (Number(employerContributions) || 0);

  const events = useMemo(
    () =>
      buildCalendarEvents({
        monthKey,
        payslips: filteredPayslips,
        creditFacilities: filteredFacilities,
        transactions: filteredTransactions,
        recurringExpenses: filteredRecurringExpenses,
        entities,
      }),
    [monthKey, filteredPayslips, filteredFacilities, filteredTransactions, filteredRecurringExpenses, entities]
  );

  const eventsByDate = useMemo(() => {
    const map = new Map<string, typeof events>();
    for (const ev of events) {
      const list = map.get(ev.date) ?? [];
      list.push(ev);
      map.set(ev.date, list);
    }
    return map;
  }, [events]);

  const monthTotals = useMemo(() => {
    const payslipNet = events
      .filter((e) => e.kind === 'payslip_net')
      .reduce((s, e) => s + e.amount, 0);
    const payslipTax = events
      .filter((e) => e.kind === 'payslip_tax')
      .reduce((s, e) => s + e.amount, 0);
    const loanDue = events
      .filter((e) => e.kind === 'loan_due')
      .reduce((s, e) => s + e.amount, 0);
    const subscriptionDue = events
      .filter((e) => e.kind === 'subscription_due')
      .reduce((s, e) => s + e.amount, 0);
    return {
      payslipNet,
      payslipTax,
      loanDue,
      subscriptionDue,
      combined: payslipNet + payslipTax + loanDue + subscriptionDue,
    };
  }, [events]);

  // Calendar grid days
  const calendarCells = useMemo(() => {
    const [yStr, mStr] = monthKey.split('-');
    const year = Number(yStr);
    const month = Number(mStr) - 1;
    const firstDay = new Date(Date.UTC(year, month, 1));
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const startOffset = (firstDay.getUTCDay() + 6) % 7;
    const cells: Array<{ date: string | null; dayNum: number | null }> = [];
    for (let i = 0; i < startOffset; i++) {
      cells.push({ date: null, dayNum: null });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${monthKey}-${String(d).padStart(2, '0')}`;
      cells.push({ date: dateStr, dayNum: d });
    }
    while (cells.length % 7 !== 0) {
      cells.push({ date: null, dayNum: null });
    }
    return cells;
  }, [monthKey]);

  const annualSummary = useMemo(() => {
    const baseYear = monthKey.slice(0, 4);
    const rows: Array<{
      mKey: string;
      label: string;
      gross: number;
      net: number;
      withholdings: number;
      employerCost: number;
      totalPayroll: number;
    }> = [];

    for (let m = 1; m <= 12; m++) {
      const mKey = `${baseYear}-${String(m).padStart(2, '0')}`;
      const mPayslips = filteredPayslips.filter(
        (p) => p.payDate.startsWith(mKey) || p.taxDueDate.startsWith(mKey)
      );
      const gross = mPayslips
        .filter((p) => p.payDate.startsWith(mKey))
        .reduce((s, p) => s + p.grossPay, 0);
      const net = mPayslips
        .filter((p) => p.payDate.startsWith(mKey))
        .reduce((s, p) => s + p.netPay, 0);
      const withholdings = mPayslips
        .filter((p) => p.taxDueDate.startsWith(mKey))
        .reduce((s, p) => s + p.employeeWithholdings, 0);
      const employerCost = mPayslips
        .filter((p) => p.taxDueDate.startsWith(mKey))
        .reduce((s, p) => s + p.employerTaxes + p.employerContributions, 0);
      rows.push({
        mKey,
        label: formatMonthLabel(mKey),
        gross,
        net,
        withholdings,
        employerCost,
        totalPayroll: net + withholdings + employerCost,
      });
    }
    return rows;
  }, [monthKey, filteredPayslips]);

  const selectedDayEvents = eventsByDate.get(selectedDate) ?? [];

  const handleUploadPayslip = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setParsing(true);
    try {
      const payload = await readUploadPayload(file);
      const resp = await apiFetch('/api/parse/payslip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await resp.json()) as {
        data?: ParsedPayslipDraft | null;
        items?: ParsedPayslipDraft[];
        error?: string;
      };
      const items =
        Array.isArray(json.items) && json.items.length > 0
          ? json.items
          : json.data
          ? [json.data]
          : [];
      if (!resp.ok || items.length === 0) {
        throw new Error(json.error || 'Unable to extract payslip fields.');
      }

      if (items.length > 1) {
        setBatchEntityId(formEntityId || defaultEntityId);
        setBatchFilename(file.name);
        setBatchMarkPaid(false);
        setBatchItems(items.map((item) => ({ ...item, selected: true })));
        pushToast(
          `${items.length} employee payslips extracted`,
          `Review all extracted slips from ${file.name} and save to calendar.`,
          'success'
        );
        return;
      }

      const d = items[0];
      setEmployeeName(d.employeeName || '');
      setPeriodStart(d.periodStart || `${currentMonthKey()}-01`);
      setPeriodEnd(d.periodEnd || `${currentMonthKey()}-28`);
      setPayDate(d.payDate || monthLastWorkday);
      setTaxDueDate(d.taxDueDate || monthTaxDueNext);
      setGrossPay(String(d.grossPay ?? 0));
      setNetPay(String(d.netPay ?? 0));
      setEmployeeWithholdings(String(d.employeeWithholdings ?? 0));
      setEmployerTaxes(String(d.employerTaxes ?? 0));
      setEmployerContributions(String(d.employerContributions ?? 0));
      setSourceFilename(file.name);
      setAiNotes(d.notes || '');
      onOpenCreateModal();
      pushToast('Payslip parsed', 'Review extracted amounts and confirm calendar dates.', 'success');
    } catch (err) {
      pushToast(
        'Payslip parsing failed',
        err instanceof Error ? err.message : 'Unable to process file.',
        'error'
      );
    } finally {
      setParsing(false);
    }
  };

  const handleSaveBatchPayslips = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetEntity = batchEntityId || companyEntities[0]?.id || entities[0]?.id;
    const chosen = batchItems.filter((item) => item.selected);
    if (!targetEntity || chosen.length === 0) return;

    setSavingBatch(true);
    try {
      for (const item of chosen) {
        await addPayslip({
          entityId: targetEntity,
          employeeName: item.employeeName || 'Employee',
          periodStart: item.periodStart || `${currentMonthKey()}-01`,
          periodEnd: item.periodEnd || `${currentMonthKey()}-28`,
          payDate: item.payDate || monthLastWorkday,
          taxDueDate: item.taxDueDate || monthTaxDueNext,
          grossPay: Math.max(0, Number(item.grossPay) || 0),
          netPay: Math.max(0, Number(item.netPay) || 0),
          employeeWithholdings: Math.max(0, Number(item.employeeWithholdings) || 0),
          employerTaxes: Math.max(0, Number(item.employerTaxes) || 0),
          employerContributions: Math.max(0, Number(item.employerContributions) || 0),
          payStatus: batchMarkPaid ? 'paid' : 'scheduled',
          taxStatus: batchMarkPaid ? 'paid' : 'scheduled',
          sourceFilename: batchFilename,
        });
      }
      const firstPayDate = chosen[0]?.payDate;
      if (firstPayDate && /^\d{4}-\d{2}-\d{2}$/.test(firstPayDate)) {
        setMonthKey(firstPayDate.slice(0, 7));
        setSelectedDate(firstPayDate);
      }
      setBatchItems([]);
      setBatchFilename('');
    } finally {
      setSavingBatch(false);
    }
  };

  const handleImportNoisysource = async () => {
    setImportingNoisysource(true);
    try {
      await importNoisysourceUploadedPayslips();
      setMonthKey('2026-01');
      setSelectedDate('2026-01-30');
    } finally {
      setImportingNoisysource(false);
    }
  };

  const handleSavePayslip = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetEntity = formEntityId || entities[0]?.id;
    if (!targetEntity) return;
    setSaving(true);
    try {
      await addPayslip({
        entityId: targetEntity,
        employeeName,
        periodStart,
        periodEnd,
        payDate,
        taxDueDate,
        grossPay: Number(grossPay) || 0,
        netPay: Number(netPay) || 0,
        employeeWithholdings: Number(employeeWithholdings) || 0,
        employerTaxes: Number(employerTaxes) || 0,
        employerContributions: Number(employerContributions) || 0,
        payStatus: 'scheduled',
        taxStatus: 'scheduled',
        sourceFilename,
      });
      setMonthKey(payDate.slice(0, 7));
      setSelectedDate(payDate);
      setEmployeeName('');
      setSourceFilename('');
      setAiNotes('');
      onCloseCreateModal();
    } finally {
      setSaving(false);
    }
  };

  const openCreateContract = () => {
    const targetEnt =
      entityFilter !== 'all' && companyEntities.some((c) => c.id === entityFilter)
        ? entityFilter
        : companyEntities[0]?.id ?? '';
    const entAcc = accounts.find((a) => a.entityId === targetEnt) ?? accounts[0];
    setEditingContract(null);
    setCtrEntityId(targetEnt);
    setCtrFundingAccountId(entAcc?.id ?? '');
    setCtrWorkerName('');
    setCtrRoleTitle('');
    setCtrIsOwner(false);
    setCtrPersonalEntityId(personalEntities[0]?.id ?? '');
    setCtrSchedule('14_months');
    setCtrBaseGross('2500');
    setCtrIrsRate('18.5');
    setCtrEmpSsRate('11');
    setCtrErSsRate('23.75');
    setCtrMealMethod('card');
    setCtrMealDaily('10.46');
    setCtrChildMonthly('0');
    setCtrChildIrs(false);
    setCtrChildSs(false);
    setCtrOtherName('');
    setCtrOtherMonthly('0');
    setCtrOtherIrs(false);
    setCtrOtherSs(false);
    setCtrChange('from');
    setCtrFrom(monthKey);
    setCtrNote('');
    setContractModalOpen(true);
  };

  const openEditContract = (c: EmploymentContract) => {
    setEditingContract(c);
    setCtrEntityId(c.entityId);
    setCtrFundingAccountId(c.fundingAccountId || '');
    setCtrWorkerName(c.workerName);
    setCtrRoleTitle(c.roleTitle);
    setCtrIsOwner(c.isOwnerIncome);
    setCtrPersonalEntityId(c.personalEntityId || personalEntities[0]?.id || '');
    setCtrSchedule(c.paySchedule);
    setCtrBaseGross(String(c.baseGrossMonthly));
    setCtrIrsRate(String(c.irsRate));
    setCtrEmpSsRate(String(c.employeeSsRate));
    setCtrErSsRate(String(c.employerSsRate));
    setCtrMealMethod(c.mealPaymentMethod);
    setCtrMealDaily(String(c.mealAllowanceDaily));
    setCtrChildMonthly(String(c.childVoucherMonthly));
    setCtrChildIrs(c.childVoucherSubjectToIrs);
    setCtrChildSs(c.childVoucherSubjectToSs);
    setCtrOtherName(c.otherBenefitName);
    setCtrOtherMonthly(String(c.otherBenefitMonthly));
    setCtrOtherIrs(c.otherBenefitSubjectToIrs);
    setCtrOtherSs(c.otherBenefitSubjectToSs);
    setCtrChange('from');
    setCtrFrom(monthKey);
    setCtrNote('');
    setContractModalOpen(true);
  };

  const handleSaveContract = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetEnt = ctrEntityId || companyEntities[0]?.id;
    if (!targetEnt) return;
    setSavingContract(true);
    try {
      const payload = {
        entityId: targetEnt,
        fundingAccountId: ctrFundingAccountId || ctrEntityAccounts[0]?.id || '',
        workerName: ctrWorkerName,
        roleTitle: ctrRoleTitle,
        isOwnerIncome: ctrIsOwner,
        personalEntityId: ctrIsOwner ? ctrPersonalEntityId || personalEntities[0]?.id || '' : '',
        paySchedule: ctrSchedule,
        baseGrossMonthly: Number(ctrBaseGross) || 0,
        irsRate: Number(ctrIrsRate) || 0,
        employeeSsRate: Number(ctrEmpSsRate) || 0,
        employerSsRate: Number(ctrErSsRate) || 0,
        mealAllowanceDaily: ctrMealMethod === 'none' ? 0 : Number(ctrMealDaily) || 0,
        mealPaymentMethod: ctrMealMethod,
        childVoucherMonthly: Number(ctrChildMonthly) || 0,
        childVoucherSubjectToIrs: ctrChildIrs,
        childVoucherSubjectToSs: ctrChildSs,
        otherBenefitName: ctrOtherName,
        otherBenefitMonthly: Number(ctrOtherMonthly) || 0,
        otherBenefitSubjectToIrs: ctrOtherIrs,
        otherBenefitSubjectToSs: ctrOtherSs,
      };
      const terms = termsOf(payload);
      const from = isMonthKey(ctrFrom) ? ctrFrom : monthKey;
      const note = ctrNote.trim().slice(0, 200);
      if (editingContract) {
        const versions = sortedVersions(editingContract.versions);
        if (ctrChange === 'from') {
          // A change from a month on: the months before keep their terms.
          await updateEmploymentContract(editingContract.id, {
            ...payload,
            ...addVersion(editingContract, { effectiveFrom: from, note: note || 'Changed', terms }, START_MONTH),
          });
        } else if (versions.length > 0) {
          // A fix: the latest version's terms were wrong, not changed.
          const last = versions[versions.length - 1];
          await updateEmploymentContract(editingContract.id, {
            ...payload,
            ...withVersions([...versions.slice(0, -1), { ...last, terms, note: note || last.note }]),
          });
        } else {
          await updateEmploymentContract(editingContract.id, payload);
        }
      } else {
        await addEmploymentContract({
          ...payload,
          versions: [{ effectiveFrom: from, note: note || 'Start', terms }],
          active: true,
        });
      }
      setContractModalOpen(false);
      setEditingContract(null);
    } finally {
      setSavingContract(false);
    }
  };

  const handleGenerateMonth = async (contractId?: string) => {
    setGenerating(true);
    try {
      const count = await generatePayslipsFromContracts({
        monthKeys: [monthKey],
        entityId: entityFilter !== 'all' ? entityFilter : undefined,
        contractId,
      });
      if (count && count > 0) {
        setSelectedDate(monthLastWorkday);
        setViewMode('calendar');
      }
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateYear = async () => {
    setGenerating(true);
    try {
      const keys = Array.from({ length: 12 }, (_, idx) => addMonths(monthKey, idx));
      const count = await generatePayslipsFromContracts({
        monthKeys: keys,
        entityId: entityFilter !== 'all' ? entityFilter : undefined,
      });
      if (count && count > 0) {
        setSelectedDate(monthLastWorkday);
        setViewMode('calendar');
      }
    } finally {
      setGenerating(false);
    }
  };

  const activeContractsCount = filteredEmploymentContracts.filter((c) => c.active).length;

  return (
    <div className="space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.txt"
        onChange={handleUploadPayslip}
        className="hidden"
      />

      {/* Header & Controls */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 bg-[#0F172A] border border-slate-800 rounded-xl p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 bg-[#1E293B] border border-slate-700 rounded-lg p-1">
            <button
              onClick={() => {
                const next = addMonths(monthKey, -1);
                setMonthKey(next);
                setSelectedDate(getLastWorkableDayOfMonth(next));
              }}
              className="p-1.5 text-slate-300 hover:text-white rounded cursor-pointer"
              aria-label="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 text-sm font-semibold font-mono tabular-nums text-slate-100 whitespace-nowrap">
              {formatMonthLabel(monthKey)}
            </span>
            <button
              onClick={() => {
                const next = addMonths(monthKey, 1);
                setMonthKey(next);
                setSelectedDate(getLastWorkableDayOfMonth(next));
              }}
              className="p-1.5 text-slate-300 hover:text-white rounded cursor-pointer"
              aria-label="Next month"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#1E293B] border border-slate-700 rounded-lg">
            <button
              onClick={() => setViewMode('calendar')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === 'calendar' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Monthly Calendar
            </button>
            <button
              onClick={() => setViewMode('annual')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === 'annual' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Annual Cost Matrix
            </button>
            <button
              onClick={() => setViewMode('contracts')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === 'contracts' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Contracts ({filteredEmploymentContracts.length})
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {activeContractsCount > 0 && (
            <button
              onClick={() => void handleGenerateMonth()}
              disabled={generating}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <CalendarCheck className="w-3.5 h-3.5" />
              <span>{generating ? 'Scheduling...' : `Generate ${formatMonthLabel(monthKey)} Payroll`}</span>
            </button>
          )}
          <button
            onClick={openCreateContract}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>New Contract</span>
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={parsing}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{parsing ? 'Parsing...' : 'Upload Payslip'}</span>
          </button>
          <button
            onClick={() => {
              setAiNotes('');
              setSourceFilename('');
              setPayDate(monthLastWorkday);
              setTaxDueDate(monthTaxDueNext);
              onOpenCreateModal();
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Manual Entry</span>
          </button>
        </div>
      </div>

      {/* Uploaded Noisysource Payslips One-Click Import Banner */}
      {importedNoisysourceCount < 6 && (
        <div className="bg-[#0F172A] border border-blue-500/40 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-slate-100">
              Uploaded Noisysource Payslips Ready (Dec 2025 &amp; Jan 2026)
            </p>
            <p className="text-xs text-slate-400">
              NOISYSOURCE - LDA (NIPC 517010585) · 6 payslips across Renato, Marisa &amp; Bernardo + 3 employment contracts
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleImportNoisysource()}
            disabled={importingNoisysource}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <CalendarCheck className="w-4 h-4" />
            <span>
              {importingNoisysource
                ? 'Creating Noisysource & Payslips...'
                : 'Create Noisysource & Import 6 Payslips'}
            </span>
          </button>
        </div>
      )}

      {/* Month Cost KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Net Salaries &amp; Benefits ({formatMonthLabel(monthKey)})</p>
          <p className="text-xl font-semibold font-mono tabular-nums text-slate-50 mt-2">
            {formatMoney(monthTotals.payslipNet, currencyCode)}
          </p>
          <p className="text-xs text-slate-500 mt-1.5 font-mono tabular-nums">
            Last workday: {monthLastWorkday} ({monthWorkDays}d)
          </p>
        </div>
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">IRS + SS/TSU Due ({formatMonthLabel(monthKey)})</p>
          <p className="text-xl font-semibold font-mono tabular-nums text-amber-300 mt-2">
            {formatMoney(monthTotals.payslipTax, currencyCode)}
          </p>
          <p className="text-xs text-slate-500 mt-1.5 font-mono tabular-nums">
            Prior month taxes due 20th
          </p>
        </div>
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Debt &amp; Subscriptions Due</p>
          <p className="text-xl font-semibold font-mono tabular-nums text-slate-50 mt-2">
            {formatMoney(monthTotals.loanDue + monthTotals.subscriptionDue, currencyCode)}
          </p>
          <p className="text-xs text-slate-500 mt-1.5 font-mono tabular-nums">
            Loans {formatMoney(monthTotals.loanDue, currencyCode, true)} · Subs{' '}
            {formatMoney(monthTotals.subscriptionDue, currencyCode, true)}
          </p>
        </div>
        <div className="bg-[#0F172A] border border-slate-800 rounded-xl p-5">
          <p className="text-xs text-slate-400">Total Scheduled Month Cash Outflow</p>
          <p className="text-xl font-semibold font-mono tabular-nums text-blue-400 mt-2">
            {formatMoney(monthTotals.combined, currencyCode)}
          </p>
          <p className="text-xs text-slate-500 mt-1.5">
            {activeContractsCount} active contract{activeContractsCount === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {viewMode === 'calendar' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Calendar Grid */}
          <div className="xl:col-span-8 bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
            <div className="grid grid-cols-7 border-b border-slate-800 bg-[#111827]">
              {WEEKDAYS.map((day) => (
                <div key={day} className="py-2.5 px-2 text-center text-xs font-medium text-slate-400">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 divide-x divide-y divide-slate-800/80">
              {calendarCells.map((cell, idx) => {
                if (!cell.date || !cell.dayNum) {
                  return <div key={`empty-${idx}`} className="min-h-[96px] bg-[#0B1120]/40" />;
                }
                const dayEvents = eventsByDate.get(cell.date) ?? [];
                const daySum = dayEvents.reduce((s, ev) => s + ev.amount, 0);
                const isSelected = selectedDate === cell.date;
                const isToday = cell.date === todayIsoDate();
                const isPayday = cell.date === monthLastWorkday;

                return (
                  <button
                    key={cell.date}
                    type="button"
                    onClick={() => setSelectedDate(cell.date!)}
                    className={`min-h-[96px] p-2 text-left flex flex-col justify-between transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-blue-950/40 ring-1 ring-inset ring-blue-500'
                        : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full gap-1">
                      <span
                        className={`text-xs font-mono tabular-nums ${
                          isToday
                            ? 'text-blue-400 font-bold'
                            : isSelected
                            ? 'text-slate-100 font-semibold'
                            : 'text-slate-400'
                        }`}
                      >
                        {cell.dayNum}
                        {isPayday && (
                          <span className="ml-1 font-sans text-[10px] text-sky-400 font-normal">
                            Payday
                          </span>
                        )}
                      </span>
                      {daySum > 0 && (
                        <span className="text-[10px] font-mono tabular-nums text-amber-300">
                          -{formatMoney(daySum, currencyCode, true)}
                        </span>
                      )}
                    </div>

                    <div className="space-y-1 mt-1.5 w-full overflow-hidden">
                      {dayEvents.slice(0, 2).map((ev) => (
                        <div
                          key={ev.id}
                          className={`text-[11px] truncate px-1.5 py-0.5 rounded ${
                            ev.status === 'paid'
                              ? 'bg-emerald-950/60 text-emerald-300'
                              : ev.kind === 'payslip_tax'
                              ? 'bg-amber-950/60 text-amber-200'
                              : ev.kind === 'payslip_net'
                              ? 'bg-blue-950/70 text-blue-200'
                              : ev.kind === 'subscription_due'
                              ? 'bg-violet-950/60 text-violet-200'
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {ev.title}
                        </div>
                      ))}
                      {dayEvents.length > 2 && (
                        <p className="text-[10px] text-slate-400 px-1">
                          +{dayEvents.length - 2} more
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Day Inspector */}
          <aside className="xl:col-span-4 bg-[#0F172A] border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <p className="text-xs text-slate-400">
                  Selected Date{selectedDate === monthLastWorkday ? ' · Last Workable Day' : ''}
                  {selectedDate.endsWith('-20') ? ' · AT / SS Tax Due Date' : ''}
                </p>
                <h3 className="text-base font-semibold font-mono tabular-nums text-slate-100 mt-0.5">
                  {selectedDate}
                </h3>
              </div>
              <CalendarDays className="w-4 h-4 text-slate-400" />
            </div>

            {selectedDayEvents.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">
                No payroll or loan obligations scheduled on {selectedDate}.
              </p>
            ) : (
              <div className="divide-y divide-slate-800/80">
                {selectedDayEvents.map((ev) => {
                  const matchingPayslip =
                    ev.kind === 'payslip_net' || ev.kind === 'payslip_tax'
                      ? filteredPayslips.find((p) => p.id === ev.sourceId)
                      : undefined;
                  const contractFunding = matchingPayslip?.contractId
                    ? employmentContracts.find((c) => c.id === matchingPayslip.contractId)?.fundingAccountId
                    : undefined;

                  return (
                    <div key={ev.id} className="py-3.5 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-100">{ev.title}</p>
                          <p className="text-xs text-slate-400 mt-0.5">
                            {ev.entityName} · {ev.subtitle}
                          </p>
                        </div>
                        <span className="text-sm font-mono tabular-nums font-semibold text-slate-100 shrink-0">
                          {formatMoney(ev.amount, currencyCode)}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-xs">
                        <span
                          className={`inline-flex items-center gap-1 ${
                            ev.status === 'paid'
                              ? 'text-emerald-400'
                              : ev.status === 'overdue'
                              ? 'text-rose-400'
                              : 'text-amber-300'
                          }`}
                        >
                          {ev.status === 'paid' ? (
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          ) : (
                            <Clock className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {ev.status === 'paid'
                              ? 'Paid'
                              : ev.status === 'overdue'
                              ? 'Overdue'
                              : 'Scheduled'}
                          </span>
                        </span>

                        {matchingPayslip && ev.status !== 'paid' && (
                          <button
                            onClick={() =>
                              void markPayslipStatus(
                                matchingPayslip,
                                ev.kind === 'payslip_net' ? 'payStatus' : 'taxStatus',
                                contractFunding ||
                                  accounts.find((a) => a.entityId === matchingPayslip.entityId)?.id
                              )
                            }
                            className="px-2.5 py-1 bg-[#1E293B] hover:bg-slate-700 border border-slate-700 text-slate-200 rounded text-xs font-medium cursor-pointer"
                          >
                            Mark Paid
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>
        </div>
      )}

      {viewMode === 'annual' && (
        <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-800">
            <h2 className="text-base font-semibold text-slate-100">
              {monthKey.slice(0, 4)} Annual Payslip Cost Breakdown
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">Month</th>
                  <th className="py-3 px-4 font-medium text-right">Gross Pay &amp; Benefits</th>
                  <th className="py-3 px-4 font-medium text-right">Net Disbursement</th>
                  <th className="py-3 px-4 font-medium text-right">Employee Withholdings</th>
                  <th className="py-3 px-4 font-medium text-right">Employer TSU &amp; Social</th>
                  <th className="py-3 px-6 font-medium text-right">Total Employer Cash Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-xs font-mono tabular-nums">
                {annualSummary.map((r) => (
                  <tr key={r.mKey} className="hover:bg-slate-800/40">
                    <td className="py-3 px-6 font-sans font-medium text-slate-200">{r.label}</td>
                    <td className="py-3 px-4 text-right text-slate-300">
                      {formatMoney(r.gross, currencyCode)}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-200">
                      {formatMoney(r.net, currencyCode)}
                    </td>
                    <td className="py-3 px-4 text-right text-amber-300">
                      {formatMoney(r.withholdings, currencyCode)}
                    </td>
                    <td className="py-3 px-4 text-right text-amber-300">
                      {formatMoney(r.employerCost, currencyCode)}
                    </td>
                    <td className="py-3 px-6 text-right font-semibold text-slate-100">
                      {formatMoney(r.totalPayroll, currencyCode)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {viewMode === 'contracts' && (
        <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Employment Contracts &amp; Portuguese Benefits Rules
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Salaries pay on the last workable day ({monthLastWorkday}); IRS + SS (11%) + TSU (23.75%) remit on the 20th of next month ({monthTaxDueNext}). Meal card exempt ≤ €{PT_MEAL_EXEMPT_CARD}/d · cash ≤ €{PT_MEAL_EXEMPT_CASH}/d.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void handleGenerateYear()}
                disabled={generating || activeContractsCount === 0}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#1E293B] hover:bg-slate-700 disabled:opacity-50 border border-slate-700 text-xs font-medium text-slate-100 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                <CalendarCheck className="w-3.5 h-3.5" />
                <span>Generate 12-Month Schedule</span>
              </button>
              <button
                onClick={openCreateContract}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Contract</span>
              </button>
            </div>
          </div>

          {filteredEmploymentContracts.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              No employment contracts configured yet. Add contracts for owners and staff to compute meal/child voucher exemptions and auto-generate salary &amp; tax events.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs text-slate-400">
                    <th className="py-3 px-6 font-medium">Worker &amp; Company</th>
                    <th className="py-3 px-4 font-medium">Base Salary &amp; Rates</th>
                    <th className="py-3 px-4 font-medium">Benefits &amp; PT Exemption</th>
                    <th className="py-3 px-4 font-medium text-right">
                      Net Pay ({formatMonthLabel(monthKey)})
                    </th>
                    <th className="py-3 px-4 font-medium text-right">IRS + SS + TSU (20th)</th>
                    <th className="py-3 px-4 font-medium text-right">Employer Cost</th>
                    <th className="py-3 px-6 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {filteredEmploymentContracts.map((c) => {
                    const brk = computeContractMonthlyBreakdown(c, monthKey);
                    const annual = computeContractAnnualTotals(c);
                    const versions = sortedVersions(c.versions);
                    const inForce = versionAt(c, monthKey);
                    const t = { ...c, ...termsAt(c, monthKey) };
                    return (
                      <React.Fragment key={c.id}>
                      <tr
                        className={`hover:bg-slate-800/40 transition-colors ${c.active ? '' : 'opacity-50'}`}
                      >
                        <td className="py-3.5 px-6">
                          <div className="flex items-start gap-2">
                            <UserCheck
                              className={`w-4 h-4 mt-0.5 shrink-0 ${
                                c.isOwnerIncome ? 'text-sky-400' : 'text-slate-400'
                              }`}
                            />
                            <div>
                              <p className="font-medium text-slate-100">
                                {c.workerName} · {c.roleTitle}
                              </p>
                              <p className="text-xs text-slate-400 mt-0.5">
                                {entityMap.get(c.entityId) ?? 'Company'}
                                {c.fundingAccountId && accountMap.get(c.fundingAccountId)
                                  ? ` · ${accountMap.get(c.fundingAccountId)}`
                                  : ''}
                              </p>
                              {c.isOwnerIncome && (
                                <p className="text-[11px] text-sky-400 mt-0.5">
                                  Owner · Auto-feeds Personal Income &amp; IRS
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-xs">
                          <p className="font-mono tabular-nums text-slate-200 font-medium">
                            {formatMoney(t.baseGrossMonthly, currencyCode)} / mo ·{' '}
                            {t.paySchedule === '14_months' ? '14x' : '12x'}
                          </p>
                          <p className="text-slate-400 font-mono tabular-nums mt-0.5">
                            IRS {t.irsRate.toFixed(1)}% · SS {t.employeeSsRate.toFixed(1)}% · TSU{' '}
                            {t.employerSsRate.toFixed(2)}%
                          </p>
                          {versions.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setHistoryOpen(historyOpen === c.id ? null : c.id)}
                              className="text-[11px] text-blue-400 hover:text-blue-300 mt-0.5 cursor-pointer"
                            >
                              {inForce ? `In ${monthLabel(monthKey)}: from ${monthLabel(inForce.effectiveFrom)}` : `Not yet in force in ${monthLabel(monthKey)}`}
                              {' · '}
                              {versions.length} version{versions.length === 1 ? '' : 's'}
                            </button>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-xs text-slate-300 space-y-0.5">
                          <p>
                            {t.mealPaymentMethod === 'none' || t.mealAllowanceDaily <= 0
                              ? 'No meal allowance'
                              : `Meal ${t.mealPaymentMethod === 'card' ? 'Card' : 'Cash'} €${t.mealAllowanceDaily.toFixed(2)}/d (${
                                  brk.mealTaxable > 0
                                    ? `${formatMoney(brk.mealExempt, currencyCode)} exempt · ${formatMoney(brk.mealTaxable, currencyCode)} taxable`
                                    : '100% exempt'
                                })`}
                          </p>
                          {t.childVoucherMonthly > 0 && (
                            <p className="text-slate-400">
                              Child Voucher {formatMoney(t.childVoucherMonthly, currencyCode)}/mo (
                              {t.childVoucherSubjectToIrs ? 'Taxable IRS' : 'Exempt IRS'},{' '}
                              {t.childVoucherSubjectToSs ? 'Taxable SS' : 'Exempt SS'})
                            </p>
                          )}
                          {t.otherBenefitMonthly > 0 && (
                            <p className="text-slate-400">
                              {t.otherBenefitName || 'Benefit'}{' '}
                              {formatMoney(t.otherBenefitMonthly, currencyCode)}/mo (
                              {t.otherBenefitSubjectToIrs ? 'IRS' : 'Ex. IRS'},{' '}
                              {t.otherBenefitSubjectToSs ? 'SS' : 'Ex. SS'})
                            </p>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                          <p className="text-emerald-400 font-medium">
                            {formatMoney(brk.netDisbursement, currencyCode)}
                          </p>
                          <p className="text-[11px] text-slate-500">{brk.payDate}</p>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                          <p className="text-amber-300">
                            {formatMoney(brk.totalTaxRemittance, currencyCode)}
                          </p>
                          <p className="text-[11px] text-slate-500">{brk.taxDueDate}</p>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                          <p className="font-semibold text-slate-100">
                            {formatMoney(brk.totalEmployerCost, currencyCode)}
                          </p>
                          <p className="text-[11px] text-slate-500">
                            {formatMoney(annual.annualTotalCost, currencyCode)}/yr
                          </p>
                        </td>
                        <td className="py-3.5 px-6 text-right">
                          <div className="inline-flex items-center gap-2">
                            <button
                              onClick={() => void handleGenerateMonth(c.id)}
                              disabled={!c.active || generating}
                              className="px-2 py-1 bg-[#1E293B] hover:bg-slate-700 disabled:opacity-40 border border-slate-700 text-xs text-slate-200 rounded cursor-pointer whitespace-nowrap"
                            >
                              Schedule
                            </button>
                            <button
                              onClick={() => void toggleEmploymentContract(c.id, !c.active)}
                              className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
                            >
                              {c.active ? 'Pause' : 'Enable'}
                            </button>
                            <button
                              onClick={() => openEditContract(c)}
                              aria-label={`Edit ${c.workerName}`}
                              className="text-slate-400 hover:text-slate-100 p-1 cursor-pointer"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => void deleteEmploymentContract(c.id)}
                              aria-label={`Delete ${c.workerName}`}
                              className="text-slate-500 hover:text-rose-400 p-1 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {historyOpen === c.id && versions.length > 0 && (
                        <tr className="bg-slate-900/60">
                          <td colSpan={99} className="px-6 py-3">
                            <p className="text-xs font-medium text-slate-300 mb-2">
                              Terms over time · each applies from its month until the next
                            </p>
                            <ul className="space-y-1.5">
                              {[...versions].reverse().map((v) => (
                                <li key={v.effectiveFrom} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                                  <span className="w-24 text-slate-200 font-medium">From {monthLabel(v.effectiveFrom)}</span>
                                  <span className="font-mono tabular-nums text-slate-300">
                                    {formatMoney(v.terms.baseGrossMonthly, currencyCode)} · IRS {v.terms.irsRate.toFixed(1)}% · SS{' '}
                                    {v.terms.employeeSsRate.toFixed(1)}% · TSU {v.terms.employerSsRate.toFixed(2)}%
                                    {v.terms.childVoucherMonthly > 0 ? ` · child ${formatMoney(v.terms.childVoucherMonthly, currencyCode)}` : ''}
                                  </span>
                                  <span className="text-slate-500">{v.note}</span>
                                  {versions.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const next = removeVersion(c, v.effectiveFrom);
                                        if (next) void updateEmploymentContract(c.id, { ...c, ...next });
                                      }}
                                      className="text-slate-500 hover:text-rose-400 cursor-pointer"
                                    >
                                      Remove
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Recorded Payslips Table */}
      <section className="bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-100">
            Recorded Payslips &amp; Scheduled Tax Remittances
          </h2>
          <span className="text-xs text-slate-400 font-mono tabular-nums">
            {filteredPayslips.length} scheduled record{filteredPayslips.length === 1 ? '' : 's'}
          </span>
        </div>
        {filteredPayslips.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No payslips recorded yet. Generate payroll from your Employment Contracts, upload a PDF/image/CSV payslip, or enter payroll manually.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="py-3 px-6 font-medium">Employee</th>
                  <th className="py-3 px-4 font-medium">Entity</th>
                  <th className="py-3 px-4 font-medium">Pay / Tax Dates</th>
                  <th className="py-3 px-4 font-medium text-right">Net Pay &amp; Benefits</th>
                  <th className="py-3 px-4 font-medium text-right">IRS + SS + TSU</th>
                  <th className="py-3 px-4 font-medium text-right">Total Cost</th>
                  <th className="py-3 px-6 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {filteredPayslips.map((p) => {
                  const taxTotal = p.employeeWithholdings + p.employerTaxes + p.employerContributions;
                  return (
                    <tr key={p.id} className="hover:bg-slate-800/40">
                      <td className="py-3 px-6">
                        <p className="font-medium text-slate-100">{p.employeeName}</p>
                        <p className="text-xs text-slate-400 font-mono tabular-nums">
                          {p.periodStart} → {p.periodEnd}
                          {p.sourceFilename ? ` · ${p.sourceFilename}` : ''}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-300">
                        {entityMap.get(p.entityId) ?? 'Entity'}
                      </td>
                      <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-300">
                        <p>
                          Pay: {p.payDate} ({p.payStatus})
                        </p>
                        <p className="text-slate-400">
                          Tax: {p.taxDueDate} ({p.taxStatus})
                        </p>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">
                        {formatMoney(p.netPay, currencyCode)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-amber-300">
                        {formatMoney(taxTotal, currencyCode)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-100">
                        {formatMoney(p.totalCost, currencyCode)}
                      </td>
                      <td className="py-3 px-6 text-right">
                        <button
                          onClick={() => void deletePayslip(p.id)}
                          aria-label={`Delete payslip for ${p.employeeName}`}
                          className="text-slate-500 hover:text-rose-400 p-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Employment Contract Modal */}
      {contractModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setContractModalOpen(false)} />
          <form
            onSubmit={handleSaveContract}
            className="relative z-10 max-w-3xl w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[92vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  {editingContract ? 'Edit Employment Contract' : 'New Portuguese Employment Contract'}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Configure base pay, statutory benefits, IRS/SS exemptions, and owner household linking
                </p>
              </div>
              <button
                type="button"
                onClick={() => setContractModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-2">
              {editingContract ? (
                <div className="flex flex-wrap gap-4 text-xs text-slate-200">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={ctrChange === 'from'} onChange={() => setCtrChange('from')} />
                    The terms change from a month on (the months before keep theirs)
                  </label>
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={ctrChange === 'fix'} onChange={() => setCtrChange('fix')} />
                    Fix a mistake in the latest terms
                  </label>
                </div>
              ) : null}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {(!editingContract || ctrChange === 'from') && (
                  <div>
                    <label className="block text-xs text-slate-300 mb-1">
                      {editingContract ? 'Changes from' : 'Starts in'}
                    </label>
                    <input
                      type="month"
                      value={ctrFrom}
                      onChange={(e) => setCtrFrom(e.target.value)}
                      required
                      className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                    />
                  </div>
                )}
                <div className={!editingContract || ctrChange === 'from' ? 'sm:col-span-2' : 'sm:col-span-3'}>
                  <label className="block text-xs text-slate-300 mb-1">Why (optional)</label>
                  <input
                    type="text"
                    value={ctrNote}
                    maxLength={200}
                    placeholder={editingContract ? 'Raise, new IRS table, voucher added…' : 'Start of contract'}
                    onChange={(e) => setCtrNote(e.target.value)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                  />
                </div>
              </div>
              <p className="text-[11px] text-slate-500">
                A month on leave, a bonus or a pro-rata month isn&apos;t a change of contract: record it on that month&apos;s payslip.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Employer Company</label>
                <select
                  value={ctrEntityId}
                  onChange={(e) => {
                    const nextEnt = e.target.value;
                    setCtrEntityId(nextEnt);
                    const nextAcc = accounts.find((a) => a.entityId === nextEnt);
                    if (nextAcc) setCtrFundingAccountId(nextAcc.id);
                  }}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {companyEntities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Funding Bank Account</label>
                <select
                  value={ctrFundingAccountId}
                  onChange={(e) => setCtrFundingAccountId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {ctrEntityAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name} ({acc.institution})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Worker Full Name</label>
                <input
                  type="text"
                  required
                  maxLength={100}
                  placeholder="e.g. André Martins"
                  value={ctrWorkerName}
                  onChange={(e) => setCtrWorkerName(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Role / Job Title</label>
                <input
                  type="text"
                  required
                  maxLength={80}
                  placeholder="e.g. Managing Director / Software Engineer"
                  value={ctrRoleTitle}
                  onChange={(e) => setCtrRoleTitle(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
            </div>

            <div className="p-3 bg-[#1E293B]/50 border border-slate-800 rounded-lg space-y-2.5">
              <label className="flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ctrIsOwner}
                  onChange={(e) => setCtrIsOwner(e.target.checked)}
                  className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                />
                <span>
                  Owner / Household Member — automatically feed take-home cash &amp; taxable Cat. A income into Personal Income &amp; 2026 IRS
                </span>
              </label>
              {ctrIsOwner && personalEntities.length > 0 && (
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Linked Personal Entity</label>
                  <select
                    value={ctrPersonalEntityId || personalEntities[0]?.id}
                    onChange={(e) => setCtrPersonalEntityId(e.target.value)}
                    className="w-full sm:w-1/2 bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100"
                  >
                    {personalEntities.map((pe) => (
                      <option key={pe.id} value={pe.id}>
                        {pe.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Base Gross / Mo</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={ctrBaseGross}
                  onChange={(e) => setCtrBaseGross(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">PT Schedule</label>
                <select
                  value={ctrSchedule}
                  onChange={(e) => setCtrSchedule(e.target.value as ContractPaySchedule)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-100"
                >
                  <option value="14_months">14x (Férias Jun / Natal Nov)</option>
                  <option value="12_months">12x (Duodécimos)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">IRS Retenção %</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  required
                  value={ctrIrsRate}
                  onChange={(e) => setCtrIrsRate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Employee SS %</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  required
                  value={ctrEmpSsRate}
                  onChange={(e) => setCtrEmpSsRate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Employer TSU %</label>
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="100"
                  required
                  value={ctrErSsRate}
                  onChange={(e) => setCtrErSsRate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            </div>

            {/* Portuguese Benefits Section */}
            <div className="border-t border-slate-800 pt-3 space-y-3">
              <p className="text-xs font-semibold text-slate-200">
                Benefits &amp; Portuguese Tax Exemptions (IRS &amp; Social Security)
              </p>

              {/* Meal Allowance */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Subsídio de Alimentação Method
                  </label>
                  <select
                    value={ctrMealMethod}
                    onChange={(e) => setCtrMealMethod(e.target.value as MealPaymentMethod)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                  >
                    <option value="card">Meal Card / Voucher (Exempt ≤ €{PT_MEAL_EXEMPT_CARD}/d)</option>
                    <option value="cash">Cash w/ Salary (Exempt ≤ €{PT_MEAL_EXEMPT_CASH}/d)</option>
                    <option value="none">No Meal Allowance</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Daily Meal Amount (€ / working day)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    disabled={ctrMealMethod === 'none'}
                    value={ctrMealMethod === 'none' ? '0' : ctrMealDaily}
                    onChange={(e) => setCtrMealDaily(e.target.value)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100 disabled:opacity-50"
                  />
                </div>
                <div className="text-xs text-slate-400 pb-2">
                  {ctrMealMethod === 'none' ? (
                    'Not included'
                  ) : (
                    <span>
                      {monthWorkDays} workdays: {formatMoney(contractDraftPreview.mealExempt, currencyCode)} exempt ·{' '}
                      <span className={contractDraftPreview.mealTaxable > 0 ? 'text-amber-300' : 'text-emerald-400'}>
                        {formatMoney(contractDraftPreview.mealTaxable, currencyCode)} taxable
                      </span>
                    </span>
                  )}
                </div>
              </div>

              {/* Child Voucher */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">
                    Child Voucher (Vale Infância / Mo)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={ctrChildMonthly}
                    onChange={(e) => setCtrChildMonthly(e.target.value)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-300 pt-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ctrChildIrs}
                    onChange={(e) => setCtrChildIrs(e.target.checked)}
                    className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                  />
                  <span>Subject to IRS (default exempt)</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300 pt-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ctrChildSs}
                    onChange={(e) => setCtrChildSs(e.target.checked)}
                    className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                  />
                  <span>Subject to SS / TSU (default exempt)</span>
                </label>
              </div>

              {/* Other Benefit */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-center">
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Other Benefit Name</label>
                  <input
                    type="text"
                    maxLength={60}
                    placeholder="e.g. Seguro de Saúde"
                    value={ctrOtherName}
                    onChange={(e) => setCtrOtherName(e.target.value)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-300 mb-1">Monthly Value</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={ctrOtherMonthly}
                    onChange={(e) => setCtrOtherMonthly(e.target.value)}
                    className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-300 pt-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ctrOtherIrs}
                    onChange={(e) => setCtrOtherIrs(e.target.checked)}
                    className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                  />
                  <span>Subject to IRS</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300 pt-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ctrOtherSs}
                    onChange={(e) => setCtrOtherSs(e.target.checked)}
                    className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                  />
                  <span>Subject to SS / TSU</span>
                </label>
              </div>
            </div>

            {/* Live Calculation Box */}
            <div className="p-4 bg-[#111827] border border-slate-800 rounded-lg grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <p className="text-slate-400">Preview ({formatMonthLabel(monthKey)})</p>
                <p className="font-mono tabular-nums text-slate-200 mt-1">
                  Payday: {contractDraftPreview.payDate}
                </p>
                <p className="font-mono tabular-nums text-slate-400">
                  Tax Due: {contractDraftPreview.taxDueDate}
                </p>
              </div>
              <div>
                <p className="text-slate-400">Taxable Bases</p>
                <p className="font-mono tabular-nums text-slate-200 mt-1">
                  IRS: {formatMoney(contractDraftPreview.irsTaxableBase, currencyCode)}
                </p>
                <p className="font-mono tabular-nums text-slate-400">
                  SS: {formatMoney(contractDraftPreview.ssTaxableBase, currencyCode)}
                </p>
              </div>
              <div>
                <p className="text-slate-400">Worker Net + Vouchers</p>
                <p className="font-mono tabular-nums font-semibold text-emerald-400 mt-1">
                  {formatMoney(contractDraftPreview.netDisbursement, currencyCode)}
                </p>
                <p className="font-mono tabular-nums text-slate-400">
                  Benefits: {formatMoney(contractDraftPreview.totalBenefits, currencyCode)}
                </p>
              </div>
              <div>
                <p className="text-slate-400">AT + SS Remittance / Cost</p>
                <p className="font-mono tabular-nums font-semibold text-amber-300 mt-1">
                  {formatMoney(contractDraftPreview.totalTaxRemittance, currencyCode)}
                </p>
                <p className="font-mono tabular-nums text-blue-400">
                  Cost: {formatMoney(contractDraftPreview.totalEmployerCost, currencyCode)}
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setContractModalOpen(false)}
                className="px-4 py-2 bg-[#1E293B] hover:bg-slate-700 text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingContract}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {savingContract
                  ? 'Saving...'
                  : editingContract
                  ? 'Save Contract Changes'
                  : 'Create Employment Contract'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Payslip Verification & Entry Modal */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={onCloseCreateModal} />
          <form
            onSubmit={handleSavePayslip}
            className="relative z-10 max-w-2xl w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  {sourceFilename ? 'Review Extracted Payslip' : 'Enter Payslip & Cost Schedule'}
                </h3>
                {sourceFilename && (
                  <p className="text-xs text-slate-400 mt-0.5">Source: {sourceFilename}</p>
                )}
              </div>
              <button
                type="button"
                onClick={onCloseCreateModal}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {aiNotes && (
              <div className="p-3 bg-blue-950/40 border border-blue-800/60 rounded-lg text-xs text-blue-200">
                {aiNotes}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Company / Entity</label>
                <select
                  value={formEntityId || defaultEntityId}
                  onChange={(e) => setFormEntityId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Employee / Contractor</label>
                <input
                  type="text"
                  required
                  maxLength={100}
                  placeholder="Full name"
                  value={employeeName}
                  onChange={(e) => setEmployeeName(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Period Start</label>
                <input
                  type="date"
                  required
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Period End</label>
                <input
                  type="date"
                  required
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Net Pay Date</label>
                <input
                  type="date"
                  required
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Tax Remittance Date</label>
                <input
                  type="date"
                  required
                  value={taxDueDate}
                  onChange={(e) => setTaxDueDate(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Gross Pay</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={grossPay}
                  onChange={(e) => setGrossPay(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Net Pay</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={netPay}
                  onChange={(e) => setNetPay(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Withholdings</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={employeeWithholdings}
                  onChange={(e) => setEmployeeWithholdings(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Employer Tax</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={employerTaxes}
                  onChange={(e) => setEmployerTaxes(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-300 mb-1">Social / Benefits</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={employerContributions}
                  onChange={(e) => setEmployerContributions(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-100"
                />
              </div>
            </div>

            <div className="p-3.5 bg-[#1E293B]/60 border border-slate-800 rounded-lg flex items-center justify-between">
              <span className="text-xs text-slate-300">
                Total Calculated Employer Cash Cost (Net + Withholdings + Employer Taxes &amp; Social)
              </span>
              <span className="text-base font-mono tabular-nums font-semibold text-blue-400">
                {formatMoney(calculatedTotalCost, currencyCode)}
              </span>
            </div>

            <div className="pt-3 border-t border-slate-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={onCloseCreateModal}
                className="px-4 py-2 bg-[#1E293B] hover:bg-slate-700 text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg cursor-pointer"
              >
                {saving ? 'Scheduling...' : 'Save & Schedule Calendar'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Batch Multi-Employee Payslip Review Modal */}
      {batchItems.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setBatchItems([])} />
          <form
            onSubmit={handleSaveBatchPayslips}
            className="relative z-10 max-w-4xl w-full bg-[#0F172A] border border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  Review {batchItems.length} Extracted Payslips
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Source PDF: {batchFilename}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setBatchItems([])}
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
              <div>
                <label className="block text-xs text-slate-300 mb-1">Employer Company / Entity</label>
                <select
                  value={batchEntityId}
                  onChange={(e) => setBatchEntityId(e.target.value)}
                  className="w-full bg-[#1E293B] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                >
                  {entities.map((ent) => (
                    <option key={ent.id} value={ent.id}>
                      {ent.name}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-300 pb-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={batchMarkPaid}
                  onChange={(e) => setBatchMarkPaid(e.target.checked)}
                  className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                />
                <span>Historical payslip — mark salaries &amp; taxes already Paid (no cash deduction)</span>
              </label>
            </div>

            <div className="border border-slate-800 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#111827] border-b border-slate-800 text-slate-400">
                      <th className="py-2.5 px-3 font-medium">Include</th>
                      <th className="py-2.5 px-3 font-medium">Employee</th>
                      <th className="py-2.5 px-3 font-medium">Pay / Tax Dates</th>
                      <th className="py-2.5 px-3 font-medium text-right">Gross Pay</th>
                      <th className="py-2.5 px-3 font-medium text-right">Net + Vouchers</th>
                      <th className="py-2.5 px-3 font-medium text-right">IRS + SS</th>
                      <th className="py-2.5 px-3 font-medium text-right">Employer TSU</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {batchItems.map((item, idx) => (
                      <tr key={`${item.employeeName}-${idx}`} className="hover:bg-slate-800/40">
                        <td className="py-2.5 px-3">
                          <input
                            type="checkbox"
                            checked={item.selected}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setBatchItems((prev) =>
                                prev.map((row, rIdx) => (rIdx === idx ? { ...row, selected: checked } : row))
                              );
                            }}
                            className="rounded border-slate-600 bg-[#1E293B] text-blue-600"
                          />
                        </td>
                        <td className="py-2.5 px-3">
                          <p className="font-medium text-slate-100">{item.employeeName}</p>
                          {item.notes && <p className="text-[11px] text-slate-400 mt-0.5">{item.notes}</p>}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-slate-300">
                          <p>{item.payDate}</p>
                          <p className="text-[11px] text-slate-500">Tax: {item.taxDueDate}</p>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                          {formatMoney(item.grossPay, currencyCode)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-emerald-400 font-medium">
                          {formatMoney(item.netPay, currencyCode)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-amber-300">
                          {formatMoney(item.employeeWithholdings, currencyCode)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-200">
                          {formatMoney(item.employerTaxes + item.employerContributions, currencyCode)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setBatchItems([])}
                className="px-4 py-2 bg-[#1E293B] hover:bg-slate-700 text-xs font-medium text-slate-200 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingBatch || batchItems.every((i) => !i.selected)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-xs font-medium text-white rounded-lg cursor-pointer whitespace-nowrap"
              >
                {savingBatch
                  ? 'Saving Payslips...'
                  : `Save ${batchItems.filter((i) => i.selected).length} Selected Payslips`}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
