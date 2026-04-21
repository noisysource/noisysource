import { useState, useEffect } from 'react';
import { Role, AppUser } from '@shared/models';
import { employeeService } from '../../services/employeeService';
import { eurosToCents } from '@shared/lib/money';
import CreateUserModal from './CreateUserModal';

export default function NewEmployeePage({ setHrSection }: { setHrSection: (section: 'list' | 'new') => void }) {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [role, setRole] = useState<Role>(Role.Teacher);
  const [paymentType, setPaymentType] = useState<'salary' | 'hourly'>('hourly');
  const [grossMonthlyEUR, setGrossMonthlyEUR] = useState('');
  const [hourlyRateEUR, setHourlyRateEUR] = useState('');
  const [irsRatePct, setIrsRatePct] = useState(0);
  const [ssEmpPct, setSsEmpPct] = useState(0);
  const [ssErPct, setSsErPct] = useState(0);
  const [payDay, setPayDay] = useState(25);
  const [startDate, setStartDate] = useState(new Date());
  const [isCreateUserModalOpen, setIsCreateUserModalOpen] = useState(false);

  const fetchUsers = async () => {
    const nonEmployeeUsers = await employeeService.getNonEmployeeUsers();
    setUsers(nonEmployeeUsers);
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedUserId) {
      alert('Please select a user.');
      return;
    }

    try {
      await employeeService.createEmployee(
        selectedUserId,
        role,
        {
          paymentType,
          grossMonthlyCents: paymentType === 'salary' ? eurosToCents(parseFloat(grossMonthlyEUR)) : null,
          hourlyRateCents: paymentType === 'hourly' ? eurosToCents(parseFloat(hourlyRateEUR)) : null,
          irsRatePct,
          ssEmpPct,
          ssErPct,
          payDay,
          startDate,
          active: true,
        }
      );
      setHrSection('list');
    } catch (error) {
      console.error("Error creating new employee:", error);
      alert("Error creating new employee. Please check the console for more details.");
    }
  };

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-800">Adicionar Novo Funcionário</h1>
        <div>
          <button onClick={() => setIsCreateUserModalOpen(true)} className="bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 mr-4">
            Criar Utilizador
          </button>
          <button onClick={() => setHrSection('list')} className="bg-gray-300 text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-400">
            Voltar
          </button>
        </div>
      </div>
      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="bg-white p-8 rounded-lg shadow-md">
          <h2 className="text-2xl font-bold text-gray-800 mb-6">Informação do Utilizador</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block font-medium text-gray-700">Utilizador</label>
              <select value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required>
                <option value="">Selecione um utilizador</option>
                {users.map(user => (
                  <option key={user.uid} value={user.uid}>{user.name} ({user.email})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-gray-700">Função</label>
              <select value={role} onChange={e => setRole(e.target.value as Role)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required>
                <option value={Role.Teacher}>Professor(a)</option>
                <option value={Role.Driver}>Motorista</option>
                <option value={Role.Animators}>Animadoras</option>
              </select>
            </div>
          </div>
        </div>

        <div className="bg-white p-8 rounded-lg shadow-md">
          <h2 className="text-2xl font-bold text-gray-800 mb-6">Informação do Contrato</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block font-medium text-gray-700">Tipo de Pagamento</label>
              <select value={paymentType} onChange={e => setPaymentType(e.target.value as 'salary' | 'hourly')} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required>
                <option value="hourly">Por Hora</option>
                <option value="salary">Salário Fixo</option>
              </select>
            </div>
            {paymentType === 'hourly' ? (
              <div>
                <label className="block font-medium text-gray-700">Valor por Hora (€)</label>
                <input type="text" value={hourlyRateEUR} onChange={e => setHourlyRateEUR(e.target.value)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
              </div>
            ) : (
              <div>
                <label className="block font-medium text-gray-700">Salário Mensal Bruto (€)</label>
                <input type="text" value={grossMonthlyEUR} onChange={e => setGrossMonthlyEUR(e.target.value)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
              </div>
            )}
            <div>
              <label className="block font-medium text-gray-700">IRS (%)</label>
              <input type="number" value={irsRatePct} onChange={e => setIrsRatePct(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">SS Funcionário (%)</label>
              <input type="number" value={ssEmpPct} onChange={e => setSsEmpPct(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">SS Empresa (%)</label>
              <input type="number" value={ssErPct} onChange={e => setSsErPct(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">Dia de Pagamento</label>
              <input type="number" value={payDay} onChange={e => setPayDay(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">Data de Início</label>
              <input type="date" value={startDate.toISOString().split('T')[0]} onChange={e => setStartDate(new Date(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button type="submit" className="bg-pink-500 text-white px-6 py-3 rounded-lg hover:bg-pink-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-pink-500 transition-colors">
            Criar Funcionário
          </button>
        </div>
      </form>

      {isCreateUserModalOpen && (
        <CreateUserModal
          onClose={() => setIsCreateUserModalOpen(false)}
          onUserCreated={fetchUsers}
        />
      )}
    </div>
  );
}
