import { FinancialEvent } from '@shared/models';

interface SidePanelProps {
  date: Date;
  entries: FinancialEvent[];
  onClose: () => void;
}

export default function SidePanel({ date, entries, onClose }: SidePanelProps) {
  const incomes = entries.filter(e => e.type === 'income');
  const expenses = entries.filter(e => e.type === 'expense');

  const incomeSummary = incomes.reduce((acc, event) => {
    const category = event.category || 'Outros';
    if (!acc[category]) {
      acc[category] = 0;
    }
    acc[category] += event.amount;
    return acc;
  }, {} as { [key: string]: number });

  return (
    <div className="fixed top-0 right-0 h-full w-1/3 bg-white shadow-lg p-4 overflow-y-auto">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">Detalhes de {date.toLocaleDateString()}</h2>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div>
        {Object.keys(incomeSummary).length > 0 && (
          <div>
            <h3 className="text-lg font-bold text-green-600">Receitas</h3>
            {Object.entries(incomeSummary).map(([category, total]) => (
              <div key={category} className="mb-4 p-4 border rounded-lg shadow-sm bg-gray-50">
                <p className="text-lg font-semibold">{category}</p>
                <p><span className="font-bold">Valor:</span> €{total.toFixed(2)}</p>
              </div>
            ))}
          </div>
        )}
        {expenses.length > 0 && (
          <div className="mt-4">
            <h3 className="text-lg font-bold text-red-600">Despesas</h3>
            {expenses.map((entry, i) => (
              <div key={i} className="mb-4 p-4 border rounded-lg shadow-sm bg-gray-50">
                <p className="text-lg font-semibold">{entry.workerName}</p>
                <p><span className="font-bold">{entry.label}</span></p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <p><span className="font-bold">Início:</span> {entry.startTime ? new Date(entry.startTime.seconds * 1000).toLocaleTimeString() : 'N/A'}</p>
                  <p><span className="font-bold">Fim:</span> {entry.endTime ? new Date(entry.endTime.seconds * 1000).toLocaleTimeString() : 'N/A'}</p>
                  <p><span className="font-bold">Total:</span> {entry.totalHours?.toFixed(2)}h</p>
                  <p><span className="font-bold">Valor:</span> €{entry.amount?.toFixed(2)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
