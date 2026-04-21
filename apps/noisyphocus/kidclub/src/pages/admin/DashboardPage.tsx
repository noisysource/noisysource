import { useState, useEffect } from 'react';
import WeeklyDetailTab from '../../components/admin/WeeklyDetailTab';
import { db } from '../../lib/firebase';
import { Expense, FinancialEvent } from '@shared/models';
import { safeDate } from '@shared/lib/dates';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { collection, getDocs, Timestamp, where, query } from 'firebase/firestore';

interface DataByCategory {
  [key: string]: number;
}

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042'];
const MONTHS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

export default function DashboardPage() {
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [partyRevenue, setPartyRevenue] = useState(0);
  const [studyRoomRevenue, setStudyRoomRevenue] = useState(0);
  const [transportationRevenue, setTransportationRevenue] = useState(0);
  const [totalExpenses, setTotalExpenses] = useState(0);
  const [expensesByCategory, setExpensesByCategory] = useState<DataByCategory>({});
  const [revenueByCategory, setRevenueByCategory] = useState<DataByCategory>({});
  const [dailyData, setDailyData] = useState<any[]>([]);
  const [profit, setProfit] = useState(0);
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth());
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  const fetchData = async () => {
    const startOfMonth = new Date(selectedYear, selectedMonth, 1);
    const endOfMonth = new Date(selectedYear, selectedMonth + 1, 0);

    const startTimestamp = Timestamp.fromDate(startOfMonth);
    const endTimestamp = Timestamp.fromDate(endOfMonth);

    const expensesQuery = query(collection(db, 'expenses'), where('date', '>=', startTimestamp), where('date', '<=', endTimestamp));
    const financialEventsQuery = query(collection(db, 'financialEvents'), where('date', '>=', startTimestamp), where('date', '<=', endTimestamp));

    // Fetch expenses
    const expensesSnapshot = await getDocs(expensesQuery);
    const expenses = expensesSnapshot.docs.map(doc => doc.data() as Expense);

    // Fetch financial events
    const financialEventsSnapshot = await getDocs(financialEventsQuery);
    const financialEvents = financialEventsSnapshot.docs.map(doc => {
      const data = doc.data() as FinancialEvent;
      return {
        ...data,
        description: data.label,
      } as Expense;
    });

    const allExpenses = [...expenses, ...financialEvents.filter(e => (e as any).type === 'expense')];
    const allIncomes = financialEvents.filter(e => (e as any).type === 'income');

    const totalExpenses = allExpenses.reduce((acc, currentExpense) => acc + currentExpense.amount, 0);

    const expensesByDescription = allExpenses.reduce((acc, currentExpense) => {
      let description = currentExpense.description || 'Outros';
      if (description.startsWith('Driver Wage for')) {
        description = 'Driver Wage';
      } else if (description.startsWith('Teacher Wage for')) {
        description = 'Teacher Wage';
      }
      if (!acc[description]) {
        acc[description] = 0;
      }
      acc[description] += currentExpense.amount;
      return acc;
    }, {} as DataByCategory);

    const totalRevenue = allIncomes.reduce((acc, income) => acc + income.amount, 0);
    const profit = totalRevenue - totalExpenses;

    const dailyData = Array(7).fill(0).map((_, i) => ({
      name: ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][i],
      income: 0,
      expense: 0,
    }));

    allIncomes.forEach(income => {
        const day = safeDate(income.date).getDay();
        dailyData[day].income += income.amount;
    });

    allExpenses.forEach(expense => {
      const day = safeDate(expense.date).getDay();
      dailyData[day].expense += expense.amount;
    });

    const revenueByCategory = allIncomes.reduce((acc, currentIncome) => {
        const category = currentIncome.category || 'Outros';
        if (!acc[category]) {
          acc[category] = 0;
        }
        acc[category] += currentIncome.amount;
        return acc;
      }, {} as DataByCategory);

    setTotalRevenue(totalRevenue);
    setPartyRevenue(revenueByCategory['Festas'] || 0);
    setStudyRoomRevenue(revenueByCategory['Sala de Estudo'] || 0);
    setTransportationRevenue(revenueByCategory['Transporte'] || 0);
    setTotalExpenses(totalExpenses);
    setProfit(profit);
    setDailyData(dailyData);
    setExpensesByCategory(expensesByDescription);
    setRevenueByCategory(revenueByCategory);
  };

  useEffect(() => {
    fetchData();
  }, [selectedMonth, selectedYear]);

  const expenseChartData = Object.entries(expensesByCategory).map(([name, value]) => ({ name, value }));
  const revenueChartData = Object.entries(revenueByCategory).map(([name, value]) => ({ name, value }));
  const [activeTab, setActiveTab] = useState('monthly');


  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Dashboard</h1>

      <div className="flex gap-4 mb-4 border-b">
        <button onClick={() => setActiveTab('monthly')} className={`py-2 px-4 ${activeTab === 'monthly' ? 'border-b-2 border-blue-500' : ''}`}>Resumo Mensal</button>
        <button onClick={() => setActiveTab('weekly')} className={`py-2 px-4 ${activeTab === 'weekly' ? 'border-b-2 border-blue-500' : ''}`}>Detalhe Semanal</button>
      </div>

      {activeTab === 'monthly' && (
        <div>
          <div className="flex gap-4 mb-4">
            <div>
              <label className="block font-medium">Mês</label>
              <select value={selectedMonth} onChange={e => setSelectedMonth(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1">
                {MONTHS.map((month, index) => (
                  <option key={month} value={index}>{month}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium">Ano</label>
              <input type="number" value={selectedYear} onChange={e => setSelectedYear(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            <div className="bg-green-100 p-4 rounded shadow">
              <h2 className="text-lg font-bold">Receita Total</h2>
              <p className="text-2xl">€{totalRevenue.toFixed(2)}</p>
            </div>
            <div className="bg-red-100 p-4 rounded shadow">
              <h2 className="text-lg font-bold">Despesa Total</h2>
              <p className="text-2xl">€{totalExpenses.toFixed(2)}</p>
            </div>
            <div className="bg-blue-100 p-4 rounded shadow">
              <h2 className="text-lg font-bold">Lucro</h2>
              <p className="text-2xl">€{profit.toFixed(2)}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h2 className="text-xl font-bold mb-4">Detalhes da Receita</h2>
              <div className="bg-white p-4 rounded shadow">
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie data={revenueChartData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} fill="#8884d8" label>
                      {revenueChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div>
              <h2 className="text-xl font-bold mb-4">Detalhes da Despesa</h2>
              <div className="bg-white p-4 rounded shadow">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={expenseChartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="value" fill="#8884d8" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="mt-8">
              <h2 className="text-xl font-bold mb-4">Rendimento Semanal</h2>
              <div className="bg-white p-4 rounded shadow">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={dailyData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="income" fill="#82ca9d" name="Income" />
                    <Bar dataKey="expense" fill="#8884d8" name="Expense" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}
      {activeTab === 'weekly' && <WeeklyDetailTab />}
    </div>
  );
}