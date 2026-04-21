import { CATEGORIES } from '../../pages/admin/ExpensesPage';

interface ExpenseFilterProps {
  onCategoryChange: (category: string) => void;
  onStartDateChange: (date: Date | null) => void;
  onEndDateChange: (date: Date | null) => void;
  selectedCategory: string;
  startDate: Date | null;
  endDate: Date | null;
}

const ExpenseFilter = ({
  onCategoryChange,
  onStartDateChange,
  onEndDateChange,
  selectedCategory,
  startDate,
  endDate,
}: ExpenseFilterProps) => {
  return (
    <div className="flex space-x-4 mb-4">
      <div>
        <label className="block font-medium">Categoria</label>
        <select
          value={selectedCategory}
          onChange={(e) => onCategoryChange(e.target.value)}
          className="w-full border rounded px-3 py-2 mt-1"
        >
          <option value="">Todas</option>
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block font-medium">Data de Início</label>
        <input
          type="date"
          value={startDate ? startDate.toISOString().split('T')[0] : ''}
          onChange={(e) => onStartDateChange(e.target.value ? new Date(e.target.value) : null)}
          className="w-full border rounded px-3 py-2 mt-1"
        />
      </div>
      <div>
        <label className="block font-medium">Data de Fim</label>
        <input
          type="date"
          value={endDate ? endDate.toISOString().split('T')[0] : ''}
          onChange={(e) => onEndDateChange(e.target.value ? new Date(e.target.value) : null)}
          className="w-full border rounded px-3 py-2 mt-1"
        />
      </div>
    </div>
  );
};

export default ExpenseFilter;
