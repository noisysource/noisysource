import { useState, useEffect } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Timestamp } from 'firebase/firestore';

interface Income {
  id?: string;
  sourceId: string;
  type: 'study' | 'party' | 'transport';
  amount: number;
  date: Timestamp;
  description: string;
}

export default function IncomesPage() {
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchIncomes = async () => {
      setLoading(true);
      const snapshot = await getDocs(collection(db, 'incomes'));
      const incomesList = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as Income));
      incomesList.sort((a, b) => b.date.toMillis() - a.date.toMillis());
      setIncomes(incomesList);
      setLoading(false);
    };
    fetchIncomes();
  }, []);

  const getTypeClass = (type: Income['type']) => {
    switch (type) {
      case 'study':
        return 'bg-blue-100 text-blue-800';
      case 'party':
        return 'bg-pink-100 text-pink-800';
      case 'transport':
        return 'bg-purple-100 text-purple-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Rendimentos</h1>
      {loading ? (
        <p>A carregar...</p>
      ) : (
        <div className="bg-white shadow rounded-lg">
          <ul className="divide-y divide-gray-200">
            {incomes.map(income => (
              <li key={income.id} className="p-4 hover:bg-gray-50">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-lg font-medium text-gray-900">{income.description}</p>
                    <p className="text-sm text-gray-500">{income.date.toDate().toLocaleDateString()}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-medium text-green-600">€{income.amount.toFixed(2)}</p>
                    <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getTypeClass(income.type)}`}>
                      {income.type}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}