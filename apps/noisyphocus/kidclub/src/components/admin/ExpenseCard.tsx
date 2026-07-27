import { Expense } from '@shared/models';
import { format } from 'date-fns';

interface ExpenseCardProps {
  expense: Expense;
  onEdit: (expense: Expense) => void;
  onDelete: (id: string) => void;
}

const ExpenseCard = ({ expense, onEdit, onDelete }: ExpenseCardProps) => {
  return (
    <div className="border p-4 rounded-lg shadow-md hover:shadow-lg transition-shadow">
      <div className="flex justify-between items-start">
        <div>
          <p className="font-bold text-lg">{expense.description}</p>
          <p className="text-sm text-gray-600">{expense.category}</p>
        </div>
        <div className="text-right">
          <p className="font-bold text-xl text-red-500">€{expense.amount.toFixed(2)}</p>
          <p className="text-sm text-gray-600">
            {format(expense.date.toDate(), 'dd/MM/yyyy')}
          </p>
        </div>
      </div>
      {expense.notes && <p className="text-sm mt-2 bg-gray-100 p-2 rounded">{expense.notes}</p>}
      <div className="flex justify-end space-x-2 mt-4">
        <button
          onClick={() => onEdit(expense)}
          className="bg-yellow-500 text-white px-3 py-1 rounded hover:bg-yellow-600 text-sm"
        >
          Editar
        </button>
        <button
          onClick={() => onDelete(expense.id ?? '')}
          className="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600 text-sm"
        >
          Eliminar
        </button>
      </div>
    </div>
  );
};

export default ExpenseCard;
