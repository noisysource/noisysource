import { useState, useEffect } from 'react';
import { collection, addDoc, getDocs, query, where, Timestamp } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { AppUser, Role } from '@shared/models';
import { employeeService } from '../../services/employeeService';
import GenerateTimesheetModal from '../../components/admin/GenerateTimesheetModal';
import GenerateMonthTimesheetModal from '../../components/admin/GenerateMonthTimesheetModal';

interface Timesheet {
  id?: string;
  employeeId: string;
  date: Timestamp;
  hoursWorked: number;
}

export default function TimesheetsPage() {
  const [employees, setEmployees] = useState<AppUser[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [date, setDate] = useState(new Date());
  const [hoursWorked, setHoursWorked] = useState(0);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [loading, setLoading] = useState(false);
  const [isTeacherDayModalOpen, setIsTeacherDayModalOpen] = useState(false);
  const [isTeacherMonthModalOpen, setIsTeacherMonthModalOpen] = useState(false);
  const [isDriverDayModalOpen, setIsDriverDayModalOpen] = useState(false);
  const [isDriverMonthModalOpen, setIsDriverMonthModalOpen] = useState(false);

  useEffect(() => {
    const fetchEmployees = async () => {
      const emps = await employeeService.getEmployees();
      setEmployees(emps);
    };
    fetchEmployees();
  }, []);

  useEffect(() => {
    if (selectedEmployee) {
      fetchTimesheets(selectedEmployee, date);
    }
  }, [selectedEmployee, date]);

  const fetchTimesheets = async (employeeId: string, forDate: Date) => {
    setLoading(true);
    const startOfMonth = new Date(forDate.getFullYear(), forDate.getMonth(), 1);
    const endOfMonth = new Date(forDate.getFullYear(), forDate.getMonth() + 1, 0);

    const q = query(
      collection(db, 'timesheets'),
      where('employeeId', '==', employeeId),
      where('date', '>=', Timestamp.fromDate(startOfMonth)),
      where('date', '<=', Timestamp.fromDate(endOfMonth))
    );

    const timesheetsSnapshot = await getDocs(q);
    const timesheetsList = timesheetsSnapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as Timesheet));
    setTimesheets(timesheetsList);
    setLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEmployee || hoursWorked <= 0) {
      alert('Please select an employee and enter a valid number of hours.');
      return;
    }

    const newTimesheet: Omit<Timesheet, 'id'> = {
      employeeId: selectedEmployee,
      date: Timestamp.fromDate(date),
      hoursWorked,
    };

    await addDoc(collection(db, 'timesheets'), newTimesheet);

    setHoursWorked(0);
    fetchTimesheets(selectedEmployee, date);
  };

  const handleGenerateForTeacherDay = async (date: Date, teacherId: string, endTime: string) => {
    try {
      await employeeService.generateTeacherTimesheet(date, teacherId, endTime);
      setIsTeacherDayModalOpen(false);
      fetchTimesheets(teacherId, date);
    } catch (error) {
      console.error("Error generating timesheet:", error);
      alert("Error generating timesheet. Please check the console for more details.");
    }
  };

  const handleGenerateForTeacherMonth = async (month: Date, teacherId: string, endTime: string) => {
    try {
      await employeeService.generateTeacherTimesheetsForMonth(month, teacherId, endTime);
      setIsTeacherMonthModalOpen(false);
      fetchTimesheets(teacherId, month);
    } catch (error) {
      console.error("Error generating timesheets for month:", error);
      alert("Error generating timesheets for month. Please check the console for more details.");
    }
  };

  const handleGenerateForDriverDay = async (date: Date, driverId: string, endTime: string) => {
    try {
      await employeeService.generateDriverTimesheet(date, driverId, endTime);
      setIsDriverDayModalOpen(false);
      fetchTimesheets(driverId, date);
    } catch (error) {
      console.error("Error generating driver timesheet:", error);
      alert("Error generating driver timesheet. Please check the console for more details.");
    }
  };

  const handleGenerateForDriverMonth = async (month: Date, driverId: string, endTime: string) => {
    try {
      await employeeService.generateDriverTimesheetsForMonth(month, driverId, endTime);
      setIsDriverMonthModalOpen(false);
      fetchTimesheets(driverId, month);
    } catch (error) {
      console.error("Error generating driver timesheets for month:", error);
      alert("Error generating driver timesheets for month. Please check the console for more details.");
    }
  };

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Registo de Horas</h1>
        <div className="flex space-x-2">
          <button onClick={() => setIsTeacherDayModalOpen(true)} className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
            Gerar p/ Dia (Prof)
          </button>
          <button onClick={() => setIsTeacherMonthModalOpen(true)} className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600">
            Gerar p/ Mês (Prof)
          </button>
          <button onClick={() => setIsDriverDayModalOpen(true)} className="bg-purple-500 text-white px-4 py-2 rounded hover:bg-purple-600">
            Gerar p/ Dia (Motorista)
          </button>
          <button onClick={() => setIsDriverMonthModalOpen(true)} className="bg-pink-500 text-white px-4 py-2 rounded hover:bg-pink-600">
            Gerar p/ Mês (Motorista)
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1">
          <h2 className="text-xl font-bold mb-2">Adicionar Registo Manual</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block font-medium">Funcionário</label>
              <select
                value={selectedEmployee}
                onChange={e => setSelectedEmployee(e.target.value)}
                className="w-full border rounded px-3 py-2 mt-1"
                required
              >
                <option value="">Selecione um funcionário</option>
                {employees.map(emp => (
                  <option key={emp.uid} value={emp.uid}>{emp.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium">Data</label>
              <input
                type="date"
                value={date.toISOString().split('T')[0]}
                onChange={e => setDate(new Date(e.target.value))}
                className="w-full border rounded px-3 py-2 mt-1"
                required
              />
            </div>
            <div>
              <label className="block font-medium">Horas Trabalhadas</label>
              <input
                type="number"
                value={hoursWorked}
                onChange={e => setHoursWorked(Number(e.target.value))}
                className="w-full border rounded px-3 py-2 mt-1"
                required
              />
            </div>
            <button type="submit" className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
              Guardar
            </button>
          </form>
        </div>

        <div className="md:col-span-2">
          <h2 className="text-xl font-bold mb-2">Registos do Mês</h2>
          {loading ? (
            <p>A carregar...</p>
          ) : (
            <ul className="space-y-2">
              {timesheets.map(ts => (
                <li key={ts.id} className="border p-3 rounded flex justify-between items-center">
                  <span>{ts.date.toDate().toLocaleDateString()}</span>
                  <span>{ts.hoursWorked} horas</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <GenerateTimesheetModal
        isOpen={isTeacherDayModalOpen}
        onClose={() => setIsTeacherDayModalOpen(false)}
        onGenerate={handleGenerateForTeacherDay}
        employees={employees.filter(e => e.roles.teacher)}
      />
      <GenerateMonthTimesheetModal
        isOpen={isTeacherMonthModalOpen}
        onClose={() => setIsTeacherMonthModalOpen(false)}
        onGenerate={handleGenerateForTeacherMonth}
        employees={employees.filter(e => e.roles.teacher)}
      />
      <GenerateTimesheetModal
        isOpen={isDriverDayModalOpen}
        onClose={() => setIsDriverDayModalOpen(false)}
        onGenerate={handleGenerateForDriverDay}
        employees={employees.filter(e => e.roles.driver)}
      />
      <GenerateMonthTimesheetModal
        isOpen={isDriverMonthModalOpen}
        onClose={() => setIsDriverMonthModalOpen(false)}
        onGenerate={handleGenerateForDriverMonth}
        employees={employees.filter(e => e.roles.driver)}
      />
    </div>
  );
}