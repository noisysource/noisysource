import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Expense } from '@shared/models';

interface ExpenseChartProps {
  expenses: Expense[];
}

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#AF19FF', '#FF1919'];

const ExpenseChart = ({ expenses }: ExpenseChartProps) => {
  const data = expenses.reduce((acc, expense) => {
    const category = expense.category;
    const amount = expense.amount;
    const existingCategory = acc.find((item) => item.name === category);
    if (existingCategory) {
      existingCategory.value += amount;
    } else {
      acc.push({ name: category, value: amount });
    }
    return acc;
  }, [] as { name: string; value: number }[]);

  return (
    <div style={{ width: '100%', height: 300 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            labelLine={false}
            outerRadius={80}
            fill="#8884d8"
            dataKey="value"
            label={(entry) => `${entry.name}: €${entry.value.toFixed(2)}`}
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value: number) => `€${value.toFixed(2)}`} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
};

export default ExpenseChart;
