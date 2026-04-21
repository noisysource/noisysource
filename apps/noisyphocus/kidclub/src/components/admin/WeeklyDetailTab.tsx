
import { useState, useEffect } from 'react';
import { db } from '../../lib/firebase';
import { collection, getDocs, query, Timestamp, where } from 'firebase/firestore';
import { FinancialEvent } from '@shared/models';
import { safeDate } from '@shared/lib/dates';
import Calendar from '../Calendar';

const MONTHS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

export default function WeeklyDetailTab() {
  const [summaryData, setSummaryData] = useState<any[]>([]);
  const [detailData, setDetailData] = useState<{ [key: string]: FinancialEvent[] }>({});
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth());
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  const fetchMonthData = async () => {
    const startOfMonth = new Date(selectedYear, selectedMonth, 1);
    const endOfMonth = new Date(selectedYear, selectedMonth + 1, 0);

    const startTimestamp = Timestamp.fromDate(startOfMonth);
    const endTimestamp = Timestamp.fromDate(endOfMonth);

    const eventsQuery = query(
      collection(db, 'financialEvents'),
      where('date', '>=', startTimestamp),
      where('date', '<=', endTimestamp)
    );
    const eventsSnapshot = await getDocs(eventsQuery);
    const events = eventsSnapshot.docs.map(doc => doc.data() as FinancialEvent);

    const dailySummary = events.reduce((acc, event) => {
      const date = safeDate(event.date).toISOString().split('T')[0];
      if (!acc[date]) {
        acc[date] = { incomes: {}, expenses: {} };
      }

      if (event.type === 'income') {
        const category = event.category || 'Outros';
        if (!acc[date].incomes[category]) {
          acc[date].incomes[category] = 0;
        }
        acc[date].incomes[category] += event.amount;
      } else if (event.type === 'expense' && event.label.includes('Wage')) {
        let role = 'Outros';
        if (event.label.startsWith('Driver Wage for')) {
          role = 'Motorista';
        } else if (event.label.startsWith('Teacher Wage for')) {
          role = 'Professor';
        }
        if (!acc[date].expenses[role]) {
          acc[date].expenses[role] = 0;
        }
        acc[date].expenses[role] += event.amount;
      }

      return acc;
    }, {} as { [key: string]: { incomes: { [key: string]: number }, expenses: { [key: string]: number } } });

    const dailyDetails = events.reduce((acc, event) => {
      const date = safeDate(event.date).toISOString().split('T')[0];
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(event);
      return acc;
    }, {} as { [key: string]: FinancialEvent[] });

    const monthSummaryData = Object.entries(dailySummary).map(([date, data]) => ({
      date,
      ...data,
    }));

    setSummaryData(monthSummaryData);
    setDetailData(dailyDetails);
  };

  useEffect(() => {
    fetchMonthData();
  }, [selectedMonth, selectedYear]);

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Detalhe Mensal</h2>
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
      <Calendar summaryData={summaryData} detailData={detailData} month={selectedMonth} year={selectedYear} />
    </div>
  );
}
