import { useState, useEffect } from 'react';
import type { Expense } from '@shared/models';
import { Timestamp } from 'firebase/firestore';

interface EditExpenseModalProps {
  isOpen: boolean;
  onClose: () => void;
  expense: Expense | null;
  onSave: (updatedExpense: Expense) => void;
  categories: string[];
}

export default function EditExpenseModal({ isOpen, onClose, expense, onSave, categories }: EditExpenseModalProps) {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState('');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');

  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<'daily' | 'weekly' | 'monthly' | 'yearly'>('monthly');
  const [recurrenceEndDate, setRecurrenceEndDate] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && expense) {
      setDescription(expense.description);
      setAmount(expense.amount);
      setDate(expense.date instanceof Timestamp ? expense.date.toDate().toISOString().split('T')[0] : '');
      setCategory(expense.category);
      setNotes(expense.notes || '');
      setIsRecurring(expense.isRecurring || false);
      setRecurrenceFrequency(expense.recurrenceFrequency || 'monthly');
      setRecurrenceEndDate(expense.recurrenceEndDate instanceof Timestamp ? expense.recurrenceEndDate.toDate().toISOString().split('T')[0] : null);
    }
  }, [isOpen, expense]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!expense) return;

    const updatedExpense: Expense = {
      ...expense,
      description,
      amount,
      date: Timestamp.fromDate(new Date(date)),
      category,
      notes,
      isRecurring,
      recurrenceFrequency: isRecurring ? recurrenceFrequency : undefined,
      recurrenceEndDate: isRecurring && recurrenceEndDate ? Timestamp.fromDate(new Date(recurrenceEndDate)) : undefined,
    };
    onSave(updatedExpense);
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold mb-4">Editar Despesa</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block font-medium">Descrição</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="w-full border rounded px-3 py-2 mt-1" required />
          </div>
          <div>
            <label className="block font-medium">Valor</label>
            <input type="number" value={amount} onChange={e => setAmount(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1" required />
          </div>
          <div>
            <label className="block font-medium">Data</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full border rounded px-3 py-2 mt-1" required />
          </div>
          <div>
            <label className="block font-medium">Categoria</label>
            <select value={category} onChange={e => setCategory(e.target.value)} className="w-full border rounded px-3 py-2 mt-1" required>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block font-medium">Notas</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} className="w-full border rounded px-3 py-2 mt-1" />
          </div>

          <div className="flex items-center mt-4">
            <input
              type="checkbox"
              id="editIsRecurring"
              checked={isRecurring}
              onChange={e => setIsRecurring(e.target.checked)}
              className="mr-2"
            />
            <label htmlFor="editIsRecurring" className="font-medium">Despesa Recorrente</label>
          </div>

          {isRecurring && (
            <div className="space-y-4 mt-4">
              <div>
                <label className="block font-medium">Frequência</label>
                <select
                  value={recurrenceFrequency}
                  onChange={e => setRecurrenceFrequency(e.target.value as 'daily' | 'weekly' | 'monthly' | 'yearly')}
                  className="w-full border rounded px-3 py-2 mt-1"
                >
                  <option value="daily">Diário</option>
                  <option value="weekly">Semanal</option>
                  <option value="monthly">Mensal</option>
                  <option value="yearly">Anual</option>
                </select>
              </div>
              <div>
                <label className="block font-medium">Data de Fim (Opcional)</label>
                <input
                  type="date"
                  value={recurrenceEndDate || ''}
                  onChange={e => setRecurrenceEndDate(e.target.value || null)}
                  className="w-full border rounded px-3 py-2 mt-1"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end space-x-4 mt-4">
            <button type="button" onClick={onClose} className="bg-gray-300 text-gray-800 px-4 py-2 rounded hover:bg-gray-400">Cancelar</button>
            <button type="submit" className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">Guardar Alterações</button>
          </div>
        </form>
      </div>
    </div>
  );
}