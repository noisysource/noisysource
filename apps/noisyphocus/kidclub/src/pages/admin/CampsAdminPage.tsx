import React, { useState, useEffect } from 'react';
import { getDocs, getDoc, addDoc, updateDoc, deleteDoc, query, where, orderBy, Timestamp, writeBatch, doc } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { db } from '../../lib/firebase';
import { callable } from '../../lib/callable';
import { Camp, CampSubscription, CampDay } from '@shared/models/Camp';

// ── helpers ───────────────────────────────────────────────────────────────────

const safeDate = (d: any): Date => {
  if (!d) return new Date();
  if (d instanceof Date) return d;
  if (d.toDate) return d.toDate();
  if (typeof d === 'string') return new Date(d);
  return new Date();
};

function fmtDate(d?: string) {
  if (!d) return '—';
  try {
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
  } catch { return d; }
}

const CAMP_TYPE_LABELS: Record<string, string> = {
  october: 'Outubro',
  christmas: 'Natal',
  easter: 'Páscoa',
  summer: 'Verão',
  other: 'Outro',
};

const STATUS_META: Record<string, { label: string; className: string }> = {
  pending:   { label: 'Pendente',   className: 'bg-yellow-100 text-yellow-800' },
  confirmed: { label: 'Confirmada', className: 'bg-green-100 text-green-800' },
  cancelled: { label: 'Cancelada',  className: 'bg-gray-100 text-gray-500' },
};

const SUB_TYPE_LABELS: Record<string, string> = {
  day: 'Dia(s)',
  week: 'Semana(s)',
  full: 'Campo Completo',
};

// ── types ─────────────────────────────────────────────────────────────────────

type ActiveTab = 'days' | 'subscriptions';

interface CampForm {
  name: string;
  type: Camp['type'];
  startDate: string;
  endDate: string;
  description: string;
  active: boolean;
}

interface DayForm {
  date: string;
  name: string;
  morning: string;
  lunch: string;
  afternoon: string;
  capacity: number;
  price: number;
  active: boolean;
}

const emptyDayForm = (): DayForm => ({
  date: '', name: '', morning: '', lunch: '', afternoon: '',
  capacity: 20, price: 0, active: true,
});

const emptyCampForm = (): CampForm => ({
  name: '', type: 'summer', startDate: '', endDate: '', description: '', active: true,
});

const PT_WEEKDAY: Record<number, string> = {
  1: 'Segunda-feira', 2: 'Terça-feira', 3: 'Quarta-feira', 4: 'Quinta-feira', 5: 'Sexta-feira',
};

function weekdaysBetween(startDate: string, endDate: string): string[] {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dates: string[] = [];
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow >= 1 && dow <= 5) {
      dates.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`);
    }
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ── main component ────────────────────────────────────────────────────────────

export default function CampsAdminPage() {
  const [camps, setCamps] = useState<Camp[]>([]);
  const [selectedCamp, setSelectedCamp] = useState<Camp | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('days');

  const [campDays, setCampDays] = useState<CampDay[]>([]);
  const [subscriptions, setSubscriptions] = useState<CampSubscription[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Camp form
  const [campForm, setCampForm] = useState<CampForm>(emptyCampForm());
  const [savingCamp, setSavingCamp] = useState(false);
  const [showNewCamp, setShowNewCamp] = useState(false);

  // Day form
  const [dayForm, setDayForm] = useState<DayForm>(emptyDayForm());
  const [editingDayId, setEditingDayId] = useState<string | null>(null);
  const [showDayForm, setShowDayForm] = useState(false);
  const [savingDay, setSavingDay] = useState(false);

  // Action states
  const [actionId, setActionId] = useState<string | null>(null);
  const [expandedSubId, setExpandedSubId] = useState<string | null>(null);

  // ── Load camps ──────────────────────────────────────────────────────────────

  const loadCamps = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(query(col('camps'), orderBy('startDate', 'desc')));
      const list: Camp[] = snap.docs.map(d => ({
        id: d.id,
        ...(d.data() as Omit<Camp, 'id' | 'createdAt' | 'updatedAt'>),
        createdAt: safeDate(d.data().createdAt),
        updatedAt: safeDate(d.data().updatedAt),
      }));
      setCamps(list);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadCamps(); }, []);

  // ── Load camp detail data ────────────────────────────────────────────────────

  const loadCampDetail = async (camp: Camp) => {
    setLoading(true);
    setCampForm({
      name: camp.name,
      type: camp.type,
      startDate: camp.startDate,
      endDate: camp.endDate,
      description: camp.description ?? '',
      active: camp.active,
    });
    try {
      const [daysSnap, subsSnap] = await Promise.all([
        getDocs(query(col('campDays'), where('campId', '==', camp.id), orderBy('date', 'asc'))),
        getDocs(query(col('campSubscriptions'), where('campId', '==', camp.id), orderBy('createdAt', 'desc'))),
      ]);
      setCampDays(daysSnap.docs.map(d => ({
        id: d.id,
        ...(d.data() as Omit<CampDay, 'id' | 'createdAt' | 'updatedAt'>),
        createdAt: safeDate(d.data().createdAt),
        updatedAt: safeDate(d.data().updatedAt),
      })));
      setSubscriptions(subsSnap.docs.map(d => ({
        id: d.id,
        ...(d.data() as Omit<CampSubscription, 'id' | 'createdAt' | 'updatedAt'>),
        createdAt: safeDate(d.data().createdAt),
        updatedAt: safeDate(d.data().updatedAt),
      })));
    } finally {
      setLoading(false);
    }
  };

  const selectCamp = (camp: Camp) => {
    setSelectedCamp(camp);
    setShowNewCamp(false);
    setShowDayForm(false);
    setEditingDayId(null);
    setActiveTab('days');
    loadCampDetail(camp);
  };

  // ── Save camp ────────────────────────────────────────────────────────────────

  const handleSaveCamp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingCamp(true);
    setError(null);
    try {
      const now = Timestamp.now();
      const data = {
        name: campForm.name,
        type: campForm.type,
        startDate: campForm.startDate,
        endDate: campForm.endDate,
        description: campForm.description || null,
        active: campForm.active,
        updatedAt: now,
      };

      if (selectedCamp) {
        await updateDoc(docRef('camps', selectedCamp.id), data);
        setSuccessMsg('Campo guardado.');
        const updated = { ...selectedCamp, ...campForm, updatedAt: now.toDate() };
        setSelectedCamp(updated);
        setCamps(prev => prev.map(c => c.id === selectedCamp.id ? updated : c));
      } else {
        const ref = await addDoc(col('camps'), { ...data, createdAt: now });
        const newCamp: Camp = {
          id: ref.id,
          ...campForm,
          createdAt: now.toDate(),
          updatedAt: now.toDate(),
        };

        // Auto-generate one campDay per weekday in the date range
        let generatedDays: CampDay[] = [];
        if (campForm.startDate && campForm.endDate) {
          const dates = weekdaysBetween(campForm.startDate, campForm.endDate);
          if (dates.length > 0) {
            const batch = writeBatch(db);
            generatedDays = dates.map(date => {
              const [y, m, d] = date.split('-').map(Number);
              const dayRef = doc(col('campDays'));
              const dayData = {
                campId: ref.id,
                date,
                name: PT_WEEKDAY[new Date(y, m - 1, d).getDay()] ?? date,
                morning: '', lunch: '', afternoon: '',
                capacity: 20, price: 0, active: true,
                createdAt: now, updatedAt: now,
              };
              batch.set(dayRef, dayData);
              return { id: dayRef.id, ...dayData, createdAt: now.toDate(), updatedAt: now.toDate() };
            });
            await batch.commit();
          }
        }

        setCamps(prev => [newCamp, ...prev]);
        setSelectedCamp(newCamp);
        setShowNewCamp(false);
        setCampDays(generatedDays);
        setSubscriptions([]);
        setSuccessMsg(`Campo criado com ${generatedDays.length} dia(s) gerado(s).`);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingCamp(false);
    }
  };

  // ── Delete camp ──────────────────────────────────────────────────────────────

  const handleDeleteCamp = async () => {
    if (!selectedCamp) return;
    if (subscriptions.some(s => s.status !== 'cancelled')) {
      setError('Não é possível eliminar um campo com inscrições ativas. Cancele primeiro todas as inscrições.');
      return;
    }
    if (!confirm(`Eliminar o campo "${selectedCamp.name}" e todos os seus dias? Esta ação é irreversível.`)) return;
    setError(null);
    try {
      // Delete all camp days
      const batch = writeBatch(db);
      campDays.forEach(d => batch.delete(docRef('campDays', d.id)));
      await batch.commit();
      await deleteDoc(docRef('camps', selectedCamp.id));
      setCamps(prev => prev.filter(c => c.id !== selectedCamp.id));
      setSelectedCamp(null);
      setCampDays([]);
      setSubscriptions([]);
      setSuccessMsg('Campo eliminado.');
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Day CRUD ─────────────────────────────────────────────────────────────────

  const handleSaveDay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCamp) return;
    setSavingDay(true);
    setError(null);
    try {
      const now = Timestamp.now();
      const data = {
        campId: selectedCamp.id,
        date: dayForm.date,
        name: dayForm.name,
        morning: dayForm.morning,
        lunch: dayForm.lunch,
        afternoon: dayForm.afternoon,
        capacity: dayForm.capacity,
        price: dayForm.price,
        active: dayForm.active,
        updatedAt: now,
      };
      if (editingDayId) {
        await updateDoc(docRef('campDays', editingDayId), data);
        setCampDays(prev => prev.map(d => d.id === editingDayId ? { ...d, ...dayForm, updatedAt: now.toDate() } : d));
      } else {
        const ref = await addDoc(col('campDays'), { ...data, createdAt: now });
        setCampDays(prev => [...prev, { id: ref.id, ...dayForm, createdAt: now.toDate(), updatedAt: now.toDate() }].sort((a, b) => a.date.localeCompare(b.date)));
      }
      setShowDayForm(false);
      setEditingDayId(null);
      setDayForm(emptyDayForm());
      setSuccessMsg(editingDayId ? 'Dia atualizado.' : 'Dia adicionado.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingDay(false);
    }
  };

  const handleDeleteDay = async (dayId: string) => {
    if (!confirm('Eliminar este dia?')) return;
    try {
      await deleteDoc(docRef('campDays', dayId));
      setCampDays(prev => prev.filter(d => d.id !== dayId));
      setSuccessMsg('Dia eliminado.');
    } catch (e: any) {
      setError(e.message);
    }
  };

  const startEditDay = (day: CampDay) => {
    setDayForm({
      date: day.date, name: day.name, morning: day.morning,
      lunch: day.lunch, afternoon: day.afternoon,
      capacity: day.capacity, price: day.price, active: day.active,
    });
    setEditingDayId(day.id);
    setShowDayForm(true);
  };

  // ── Subscription actions ──────────────────────────────────────────────────────

  const handleConfirmSub = async (subId: string) => {
    setActionId(subId);
    setError(null);
    try {
      await callable('confirmCampSubscription')({ subscriptionId: subId });
      setSubscriptions(prev => prev.map(s => s.id === subId ? { ...s, status: 'confirmed' } : s));
      setSuccessMsg('Inscrição confirmada. Email enviado ao cliente.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionId(null);
    }
  };

  const handleCancelSub = async (subId: string) => {
    const reason = prompt('Motivo do cancelamento (opcional):') ?? undefined;
    setActionId(subId);
    setError(null);
    try {
      await callable('cancelCampSubscription')({ subscriptionId: subId, reason });
      setSubscriptions(prev => prev.map(s => s.id === subId ? { ...s, status: 'cancelled', statusReason: reason } : s));
      setSuccessMsg('Inscrição cancelada.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionId(null);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0">
      {/* Left panel — camp list */}
      <div className="w-72 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Campos</h2>
          <button
            onClick={() => { setSelectedCamp(null); setCampForm(emptyCampForm()); setShowNewCamp(true); setShowDayForm(false); }}
            className="text-sm bg-indigo-600 text-white px-3 py-1 rounded hover:bg-indigo-700"
          >
            + Novo
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {loading && camps.length === 0 ? (
            <p className="text-sm text-gray-400 p-4">A carregar...</p>
          ) : camps.length === 0 ? (
            <p className="text-sm text-gray-400 p-4">Nenhum campo criado.</p>
          ) : (
            camps.map(camp => (
              <button
                key={camp.id}
                onClick={() => selectCamp(camp)}
                className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-white transition-colors ${selectedCamp?.id === camp.id ? 'bg-white border-l-2 border-l-indigo-500' : ''}`}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="font-medium text-sm text-gray-800 truncate pr-2">{camp.name}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${camp.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {camp.active ? 'Ativo' : 'Inativo'}
                  </span>
                </div>
                <p className="text-xs text-gray-500">{CAMP_TYPE_LABELS[camp.type] ?? camp.type} · {fmtDate(camp.startDate)} – {fmtDate(camp.endDate)}</p>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 overflow-y-auto">
        {/* Feedback banners */}
        {error && (
          <div className="m-4 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded flex justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-4 font-bold">×</button>
          </div>
        )}
        {successMsg && (
          <div className="m-4 bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded flex justify-between">
            <span>{successMsg}</span>
            <button onClick={() => setSuccessMsg(null)} className="ml-4 font-bold">×</button>
          </div>
        )}

        {/* New camp form */}
        {showNewCamp && !selectedCamp && (
          <div className="p-6">
            <h2 className="text-xl font-semibold text-gray-800 mb-4">Novo Campo</h2>
            <CampFormPanel
              form={campForm}
              onChange={setCampForm}
              onSave={handleSaveCamp}
              saving={savingCamp}
              onCancel={() => setShowNewCamp(false)}
            />
          </div>
        )}

        {/* Camp detail */}
        {selectedCamp && (
          <div className="p-6 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-gray-800">{selectedCamp.name}</h2>
              <button
                onClick={handleDeleteCamp}
                className="text-sm text-red-600 hover:text-red-700 border border-red-200 hover:border-red-400 px-3 py-1.5 rounded transition-colors"
              >
                Eliminar campo
              </button>
            </div>

            {/* Camp form */}
            <div className="bg-white border border-gray-200 rounded-lg p-5">
              <h3 className="font-semibold text-gray-700 mb-4">Detalhes do campo</h3>
              <CampFormPanel
                form={campForm}
                onChange={setCampForm}
                onSave={handleSaveCamp}
                saving={savingCamp}
              />
            </div>

            {/* Tabs */}
            <div className="border-b border-gray-200">
              <nav className="-mb-px flex gap-6">
                {(['days', 'subscriptions'] as ActiveTab[]).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`pb-2 text-sm font-medium border-b-2 transition-colors ${activeTab === tab ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                  >
                    {tab === 'days' ? `Dias (${campDays.length})` : `Inscrições (${subscriptions.length})`}
                  </button>
                ))}
              </nav>
            </div>

            {/* Days tab */}
            {activeTab === 'days' && (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="font-semibold text-gray-700">Dias do campo</h3>
                  <button
                    onClick={() => { setDayForm(emptyDayForm()); setEditingDayId(null); setShowDayForm(true); }}
                    className="text-sm bg-indigo-600 text-white px-3 py-1.5 rounded hover:bg-indigo-700"
                  >
                    + Adicionar dia
                  </button>
                </div>

                {showDayForm && (
                  <div className="bg-white border border-gray-200 rounded-lg p-5">
                    <h4 className="font-medium text-gray-700 mb-4">{editingDayId ? 'Editar dia' : 'Novo dia'}</h4>
                    <form onSubmit={handleSaveDay} className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Data *</label>
                          <input type="date" required value={dayForm.date}
                            min={selectedCamp.startDate} max={selectedCamp.endDate}
                            onChange={e => setDayForm(f => ({ ...f, date: e.target.value }))}
                            className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
                          <p className="text-xs text-gray-400 mt-0.5">{fmtDate(selectedCamp.startDate)} – {fmtDate(selectedCamp.endDate)}</p>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Nome *</label>
                          <input type="text" required value={dayForm.name} onChange={e => setDayForm(f => ({ ...f, name: e.target.value }))}
                            className="w-full border border-gray-300 rounded px-3 py-2 text-sm" placeholder="ex. Dia de aventuras" />
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Manhã *</label>
                        <input type="text" required value={dayForm.morning} onChange={e => setDayForm(f => ({ ...f, morning: e.target.value }))}
                          className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Almoço *</label>
                        <input type="text" required value={dayForm.lunch} onChange={e => setDayForm(f => ({ ...f, lunch: e.target.value }))}
                          className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Tarde *</label>
                        <input type="text" required value={dayForm.afternoon} onChange={e => setDayForm(f => ({ ...f, afternoon: e.target.value }))}
                          className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
                      </div>
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Capacidade</label>
                          <input type="number" min="1" required value={dayForm.capacity} onChange={e => setDayForm(f => ({ ...f, capacity: Number(e.target.value) }))}
                            className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Preço (€)</label>
                          <input type="number" min="0" step="0.01" required value={dayForm.price} onChange={e => setDayForm(f => ({ ...f, price: Number(e.target.value) }))}
                            className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Estado</label>
                          <select value={dayForm.active ? 'active' : 'inactive'} onChange={e => setDayForm(f => ({ ...f, active: e.target.value === 'active' }))}
                            className="w-full border border-gray-300 rounded px-3 py-2 text-sm">
                            <option value="active">Ativo</option>
                            <option value="inactive">Inativo</option>
                          </select>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button type="submit" disabled={savingDay}
                          className="bg-indigo-600 text-white px-4 py-2 rounded text-sm hover:bg-indigo-700 disabled:opacity-50">
                          {savingDay ? 'A guardar...' : 'Guardar'}
                        </button>
                        <button type="button" onClick={() => { setShowDayForm(false); setEditingDayId(null); }}
                          className="bg-gray-200 px-4 py-2 rounded text-sm hover:bg-gray-300">
                          Cancelar
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {loading ? (
                  <p className="text-sm text-gray-400">A carregar...</p>
                ) : campDays.length === 0 ? (
                  <p className="text-sm text-gray-400">Nenhum dia configurado.</p>
                ) : (
                  <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Data</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Nome</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Atividades</th>
                          <th className="text-right px-4 py-3 font-medium text-gray-600">Preço</th>
                          <th className="text-right px-4 py-3 font-medium text-gray-600">Cap.</th>
                          <th className="text-center px-4 py-3 font-medium text-gray-600">Estado</th>
                          <th className="px-4 py-3"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {campDays.map(day => (
                          <tr key={day.id} className="hover:bg-gray-50">
                            <td className="px-4 py-3 font-medium text-gray-800">{fmtDate(day.date)}</td>
                            <td className="px-4 py-3 text-gray-700">{day.name}</td>
                            <td className="px-4 py-3 text-gray-500 text-xs">
                              <div>M: {day.morning}</div>
                              <div>A: {day.lunch}</div>
                              <div>T: {day.afternoon}</div>
                            </td>
                            <td className="px-4 py-3 text-right font-medium">€{day.price.toFixed(2)}</td>
                            <td className="px-4 py-3 text-right text-gray-600">{day.capacity}</td>
                            <td className="px-4 py-3 text-center">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${day.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                                {day.active ? 'Ativo' : 'Inativo'}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex gap-2">
                                <button onClick={() => startEditDay(day)} className="text-indigo-600 hover:underline text-xs">Editar</button>
                                <button onClick={() => handleDeleteDay(day.id)} className="text-red-500 hover:underline text-xs">Eliminar</button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Subscriptions tab */}
            {activeTab === 'subscriptions' && (
              <div className="space-y-4">
                {loading ? (
                  <p className="text-sm text-gray-400">A carregar...</p>
                ) : subscriptions.length === 0 ? (
                  <p className="text-sm text-gray-400">Nenhuma inscrição.</p>
                ) : (
                  <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Criança</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Encarregado</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Tipo</th>
                          <th className="text-right px-4 py-3 font-medium text-gray-600">Dias</th>
                          <th className="text-right px-4 py-3 font-medium text-gray-600">Total</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Sinal pago?</th>
                          <th className="text-left px-4 py-3 font-medium text-gray-600">Estado</th>
                          <th className="px-4 py-3"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {subscriptions.map(sub => (
                          <React.Fragment key={sub.id}>
                            <tr
                              className="hover:bg-gray-50 cursor-pointer"
                              onClick={() => setExpandedSubId(expandedSubId === sub.id ? null : sub.id)}
                            >
                              <td className="px-4 py-3">
                                <p className="font-medium text-gray-800">{sub.childName}</p>
                                {sub.childAge != null && <p className="text-xs text-gray-400">{sub.childAge} anos</p>}
                              </td>
                              <td className="px-4 py-3">
                                <p className="text-gray-700">{sub.parentName}</p>
                                <p className="text-xs text-gray-400">{sub.parentEmail}</p>
                              </td>
                              <td className="px-4 py-3 text-gray-600">{SUB_TYPE_LABELS[sub.subscriptionType] ?? sub.subscriptionType}</td>
                              <td className="px-4 py-3 text-right text-gray-600">{sub.selectedDays.length}</td>
                              <td className="px-4 py-3 text-right font-medium text-gray-800">€{sub.totalAmount.toFixed(2)}</td>
                              <td className="px-4 py-3">
                                {sub.depositBillingId ? (
                                  <span className="text-xs text-gray-500">Ver cobranças</span>
                                ) : '—'}
                              </td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_META[sub.status]?.className ?? 'bg-gray-100 text-gray-500'}`}>
                                  {STATUS_META[sub.status]?.label ?? sub.status}
                                </span>
                              </td>
                              <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                                <div className="flex gap-2">
                                  {sub.status === 'pending' && (
                                    <button
                                      onClick={() => handleConfirmSub(sub.id)}
                                      disabled={actionId === sub.id}
                                      className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700 disabled:opacity-50"
                                    >
                                      {actionId === sub.id ? '...' : 'Confirmar'}
                                    </button>
                                  )}
                                  {sub.status !== 'cancelled' && (
                                    <button
                                      onClick={() => handleCancelSub(sub.id)}
                                      disabled={actionId === sub.id}
                                      className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700 disabled:opacity-50"
                                    >
                                      {actionId === sub.id ? '...' : 'Cancelar'}
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {expandedSubId === sub.id && (
                              <tr>
                                <td colSpan={8} className="px-6 py-4 bg-gray-50 border-t border-gray-100">
                                  <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                      <p className="font-medium text-gray-700 mb-2">Dias selecionados</p>
                                      <DayDateList dayIds={sub.selectedDays} campDays={campDays} />
                                    </div>
                                    <div>
                                      <p className="font-medium text-gray-700 mb-2">Valores</p>
                                      <div className="space-y-1 text-gray-600">
                                        <div className="flex justify-between"><span>Total:</span><span className="font-medium">€{sub.totalAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between"><span>Sinal (25%):</span><span className="font-medium">€{sub.depositAmount.toFixed(2)}</span></div>
                                        <div className="flex justify-between"><span>Saldo (75%):</span><span className="font-medium">€{sub.balanceAmount.toFixed(2)}</span></div>
                                      </div>
                                      {sub.notes && (
                                        <div className="mt-3">
                                          <p className="font-medium text-gray-700 mb-1">Notas</p>
                                          <p className="text-gray-600">{sub.notes}</p>
                                        </div>
                                      )}
                                      {sub.statusReason && (
                                        <div className="mt-2">
                                          <p className="text-xs text-red-600">Motivo cancelamento: {sub.statusReason}</p>
                                        </div>
                                      )}
                                      {sub.depositRefundPending && (
                                        <div className="mt-2 text-xs text-orange-600 font-medium">
                                          Reembolso do sinal pendente (processamento manual)
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!selectedCamp && !showNewCamp && (
          <div className="flex items-center justify-center h-64 text-gray-400">
            <p>Selecione um campo ou crie um novo.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CampFormPanel({
  form, onChange, onSave, saving, onCancel,
}: {
  form: CampForm;
  onChange: (f: CampForm) => void;
  onSave: (e: React.FormEvent) => void;
  saving: boolean;
  onCancel?: () => void;
}) {
  return (
    <form onSubmit={onSave} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Nome *</label>
          <input type="text" required value={form.name} onChange={e => onChange({ ...form, name: e.target.value })}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm" placeholder="ex. Campos de Verão 2026" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Tipo *</label>
          <select value={form.type} onChange={e => onChange({ ...form, type: e.target.value as Camp['type'] })}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm">
            <option value="october">Outubro</option>
            <option value="christmas">Natal</option>
            <option value="easter">Páscoa</option>
            <option value="summer">Verão</option>
            <option value="other">Outro</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Data início *</label>
          <input type="date" required value={form.startDate} onChange={e => onChange({ ...form, startDate: e.target.value })}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Data fim *</label>
          <input type="date" required value={form.endDate} onChange={e => onChange({ ...form, endDate: e.target.value })}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Descrição</label>
        <textarea rows={2} value={form.description} onChange={e => onChange({ ...form, description: e.target.value })}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm resize-none" />
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={form.active} onChange={e => onChange({ ...form, active: e.target.checked })}
            className="w-4 h-4 text-indigo-600" />
          <span className="text-sm text-gray-700">Campo ativo (visível para clientes)</span>
        </label>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={saving}
          className="bg-indigo-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
          {saving ? 'A guardar...' : 'Guardar'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}
            className="bg-gray-200 px-4 py-2 rounded text-sm hover:bg-gray-300">
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}

function DayDateList({ dayIds, campDays }: { dayIds: string[]; campDays: CampDay[] }) {
  const dayMap = Object.fromEntries(campDays.map(d => [d.id, d]));
  const sorted = [...dayIds].sort((a, b) => {
    const da = dayMap[a]?.date ?? a;
    const db2 = dayMap[b]?.date ?? b;
    return da.localeCompare(db2);
  });
  return (
    <ul className="space-y-1">
      {sorted.map(id => {
        const d = dayMap[id];
        return (
          <li key={id} className="text-gray-600">
            {d ? `${fmtDate(d.date)} — ${d.name}` : id}
          </li>
        );
      })}
    </ul>
  );
}
