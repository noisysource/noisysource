import { useState, useEffect } from 'react';
import { Role } from '@shared/models';
import { employeeService } from '../../services/employeeService';
import { eurosToCents, centsToEuros } from '@shared/lib/money';
import { useParams, useNavigate } from 'react-router-dom';
import { AppUser } from '@shared/models';
import { EmploymentContractDoc } from '@shared/models/Employment';

export default function EditEmployeePage() {
  const { employeeId } = useParams();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(Role.Teacher);
  const [paymentType, setPaymentType] = useState<'salary' | 'hourly'>('hourly');
  const [grossMonthlyEUR, setGrossMonthlyEUR] = useState('');
  const [hourlyRateEUR, setHourlyRateEUR] = useState('');
  const [irsRatePct, setIrsRatePct] = useState(0);
  const [ssEmpPct, setSsEmpPct] = useState(0);
  const [ssErPct, setSsErPct] = useState(0);
  const [payDay, setPayDay] = useState(25);
  const [startDate, setStartDate] = useState(new Date());

  useEffect(() => {
    if (!employeeId) return;

    const fetchEmployee = async () => {
      const employee = await employeeService.getEmployee(employeeId);
      const contract = await employeeService.getEmployeeContract(employeeId);

      if (employee) {
        setName(employee.name);
        setEmail(employee.email);
        setRole(employee.roles.teacher ? Role.Teacher : Role.Driver);
      }

      if (contract) {
        setPaymentType(contract.hourlyRateCents ? 'hourly' : 'salary');
        setGrossMonthlyEUR(String(centsToEuros(contract.grossMonthlyCents)));
        setHourlyRateEUR(String(centsToEuros(contract.hourlyRateCents || 0)));
        setIrsRatePct(contract.irsRatePct);
        setSsEmpPct(contract.ssEmpPct);
        setSsErPct(contract.ssErPct);
        setPayDay(contract.payDay);
        setStartDate(contract.startDate.toDate());
      }
    };

    fetchEmployee();
  }, [employeeId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId) return;

    try {
      await employeeService.updateEmployee(
        employeeId,
        { name, email },
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
      navigate('/admin/hr');
    } catch (error) {
      console.error("Error updating employee:", error);
      alert("Error updating employee. Please check the console for more details.");
    }
  };

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-800">Edit Employee</h1>
        <button onClick={() => navigate('/admin/hr')} className="bg-gray-300 text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-400">
          Back
        </button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="bg-white p-8 rounded-lg shadow-md">
          <h2 className="text-2xl font-bold text-gray-800 mb-6">User Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block font-medium text-gray-700">Name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">Role</label>
              <select value={role} onChange={e => setRole(e.target.value as Role)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required>
                <option value={Role.Teacher}>Teacher</option>
                <option value={Role.Driver}>Driver</option>
              </select>
            </div>
          </div>
        </div>

        <div className="bg-white p-8 rounded-lg shadow-md">
          <h2 className="text-2xl font-bold text-gray-800 mb-6">Contract Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block font-medium text-gray-700">Payment Type</label>
              <select value={paymentType} onChange={e => setPaymentType(e.target.value as 'salary' | 'hourly')} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required>
                <option value="hourly">Hourly</option>
                <option value="salary">Salary</option>
              </select>
            </div>
            {paymentType === 'hourly' ? (
              <div>
                <label className="block font-medium text-gray-700">Hourly Rate (€)</label>
                <input type="text" value={hourlyRateEUR} onChange={e => setHourlyRateEUR(e.target.value)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
              </div>
            ) : (
              <div>
                <label className="block font-medium text-gray-700">Gross Monthly Salary (€)</label>
                <input type="text" value={grossMonthlyEUR} onChange={e => setGrossMonthlyEUR(e.target.value)} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
              </div>
            )}
            <div>
              <label className="block font-medium text-gray-700">IRS (%)</label>
              <input type="number" value={irsRatePct} onChange={e => setIrsRatePct(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">SS Employee (%)</label>
              <input type="number" value={ssEmpPct} onChange={e => setSsEmpPct(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">SS Employer (%)</label>
              <input type="number" value={ssErPct} onChange={e => setSsErPct(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">Pay Day</label>
              <input type="number" value={payDay} onChange={e => setPayDay(Number(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
            <div>
              <label className="block font-medium text-gray-700">Start Date</label>
              <input type="date" value={startDate.toISOString().split('T')[0]} onChange={e => setStartDate(new Date(e.target.value))} className="w-full border rounded px-3 py-2 mt-1 focus:outline-none focus:ring-2 focus:ring-pink-500" required />
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button type="submit" className="bg-pink-500 text-white px-6 py-3 rounded-lg hover:bg-pink-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-pink-500 transition-colors">
            Update Employee
          </button>
        </div>
      </form>
    </div>
  );
}
