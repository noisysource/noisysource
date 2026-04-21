import { useState, useEffect, useMemo } from 'react';
import { collection, addDoc, getDocs, Timestamp, deleteDoc, doc, updateDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import EditExpenseModal from '../../components/admin/EditExpenseModal';
import ExpenseCard from '../../components/admin/ExpenseCard';
import ExpenseFilter from '../../components/admin/ExpenseFilter';
import ExpenseChart from '../../components/admin/ExpenseChart';
import { Expense, ExpenseSchema } from '@shared/models';

export const CATEGORIES = [
  'Renda',
  'Salários',
  'Marketing',
  'Material',
  'Utilities',
  'Outros',
];

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(new Date());
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [notes, setNotes] = useState('');

  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<'daily' | 'weekly' | 'monthly' | 'yearly'>('monthly');
  const [recurrenceEndDate, setRecurrenceEndDate] = useState<Date | null>(null);

  const [expenseToEdit, setExpenseToEdit] = useState<Expense | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);

  const [filterCategory, setFilterCategory] = useState('');
  const [filterStartDate, setFilterStartDate] = useState<Date | null>(null);
  const [filterEndDate, setFilterEndDate] = useState<Date | null>(null);

  useEffect(() => {
    const fetchExpenses = async () => {
      const snapshot = await getDocs(collection(db, 'expenses'));
      const expensesList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Expense));
      setExpenses(expensesList);
    };
    fetchExpenses();
  }, []);

  const filteredExpenses = useMemo(() => {
    return expenses.filter(expense => {
      const expenseDate = expense.date.toDate();
      if (filterCategory && expense.category !== filterCategory) {
        return false;
      }
      if (filterStartDate && expenseDate < filterStartDate) {
        return false;
      }
      if (filterEndDate && expenseDate > filterEndDate) {
        return false;
      }
      return true;
    });
  }, [expenses, filterCategory, filterStartDate, filterEndDate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const newExpense: Omit<Expense, 'id'> = {
      description,
      amount,
      date: Timestamp.fromDate(date),
      category,
      notes,
      createdAt: Timestamp.now(),
      isRecurring,
      recurrenceFrequency: isRecurring ? recurrenceFrequency : undefined,
      recurrenceEndDate: isRecurring && recurrenceEndDate ? Timestamp.fromDate(recurrenceEndDate) : undefined,
    };

    const validatedExpense = ExpenseSchema.omit({ id: true }).safeParse(newExpense);

    if (!validatedExpense.success) {
      console.error(validatedExpense.error);
      // Handle validation error (e.g., show a message to the user)
      return;
    }

    await addDoc(collection(db, 'expenses'), validatedExpense.data);

    // Refresh expenses list
    const snapshot = await getDocs(collection(db, 'expenses'));
    const expensesList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Expense));
    setExpenses(expensesList);

    // Clear form
    setDescription('');
    setAmount(0);
    setDate(new Date());
    setCategory(CATEGORIES[0]);
    setNotes('');
    setIsRecurring(false);
    setRecurrenceFrequency('monthly');
    setRecurrenceEndDate(null);
  };

  const handleDelete = async (id: string) => {
    if (window.confirm("Tem certeza que deseja eliminar esta despesa?")) {
      await deleteDoc(doc(db, "expenses", id));
      setExpenses(expenses.filter(exp => exp.id !== id));
    }
  };

  const handleEdit = (expense: Expense) => {
    setExpenseToEdit(expense);
    setShowEditModal(true);
  };

  const handleSaveEdit = async (updatedExpense: Expense) => {
    if (updatedExpense.id) {
      await updateDoc(doc(db, "expenses", updatedExpense.id), updatedExpense);
      setExpenses(expenses.map(exp => exp.id === updatedExpense.id ? updatedExpense : exp));
    }
    setShowEditModal(false);
    setExpenseToEdit(null);
  };

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <h1 className="text-3xl font-bold mb-6 text-gray-800">Gestão de Despesas</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1 bg-white p-6 rounded-lg shadow-md">
          <h2 className="text-2xl font-bold mb-4">Adicionar Despesa</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block font-medium text-gray-700">Descrição</label>
              <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">Valor</label>
              <input type="number" value={amount} onChange={e => setAmount(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">Data</label>
              <input type="date" value={date.toISOString().split('T')[0]} onChange={e => setDate(new Date(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-blue-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">Categoria</label>
              <select value={category} onChange={e => setCategory(e.target.value)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-blue-500" required>
                {CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-gray-700">Notas</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            <div className="flex items-center mt-4">
              <input
                type="checkbox"
                id="isRecurring"
                checked={isRecurring}
                onChange={e => setIsRecurring(e.target.checked)}
                className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="isRecurring" className="font-medium text-gray-700">Despesa Recorrente</label>
            </div>

            {isRecurring && (
              <div className="space-y-4 mt-4 p-4 bg-gray-100 rounded-lg">
                <div>
                  <label className="block font-medium text-gray-700">Frequência</label>
                  <select
                    value={recurrenceFrequency}
                    onChange={e => setRecurrenceFrequency(e.target.value as 'daily' | 'weekly' | 'monthly' | 'yearly')}
                    className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="daily">Diário</option>
                    <option value="weekly">Semanal</option>
                    <option value="monthly">Mensal</option>
                    <option value="yearly">Anual</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-gray-700">Data de Fim (Opcional)</label>
                  <input
                    type="date"
                    value={recurrenceEndDate ? recurrenceEndDate.toISOString().split('T')[0] : ''}
                    onChange={e => setRecurrenceEndDate(e.target.value ? new Date(e.target.value) : null)}
                    className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            )}

            <button type="submit" className="w-full bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors">Adicionar</button>
          </form>
        </div>

        <div className="lg:col-span-2">
          <div className="bg-white p-6 rounded-lg shadow-md mb-8">
            <h2 className="text-2xl font-bold mb-4">Visão Geral das Despesas</h2>
            <ExpenseChart expenses={filteredExpenses} />
          </div>

          <div className="bg-white p-6 rounded-lg shadow-md">
            <h2 className="text-2xl font-bold mb-4">Despesas Registadas</h2>
            <ExpenseFilter
              onCategoryChange={setFilterCategory}
              onStartDateChange={setFilterStartDate}
              onEndDateChange={setFilterEndDate}
              selectedCategory={filterCategory}
              startDate={filterStartDate}
              endDate={filterEndDate}
            />
            <div className="space-y-4">
              {filteredExpenses.map(expense => (
                <ExpenseCard
                  key={expense.id}
                  expense={expense}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {showEditModal && expenseToEdit && (
        <EditExpenseModal
          isOpen={showEditModal}
          onClose={() => setShowEditModal(false)}
          expense={expenseToEdit}
          onSave={handleSaveEdit}
          categories={CATEGORIES}
        />
      )}
    </div>
  );
}