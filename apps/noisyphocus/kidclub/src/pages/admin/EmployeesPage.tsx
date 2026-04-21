import { useState, useEffect, useMemo } from 'react';
import { AppUser } from '@shared/models';
import { employeeService } from '../../services/employeeService';
import { Link } from 'react-router-dom';

import { getFunctions, httpsCallable } from 'firebase/functions';
import { signInWithCustomToken } from 'firebase/auth';
import { auth } from '../../lib/firebase';

function EmployeeCard({ employee }: { employee: AppUser }) {
  const role = Object.keys(employee.roles).find(role => employee.roles[role as keyof typeof employee.roles]);

  const handleImpersonate = async () => {
    try {
      const functions = getFunctions();
      const impersonateUser = httpsCallable(functions, 'impersonateUser');
      const result = await impersonateUser({ uid: employee.uid });
      const { token } = result.data as { token: string };

      await signInWithCustomToken(auth, token);
      window.location.href = '/client';
    } catch (error) {
      console.error('Error impersonating user:', error);
      alert('Failed to impersonate user.');
    }
  };

  return (
    <div className="bg-white shadow rounded-lg p-4 flex flex-col justify-between">
      <div>
        <p className="text-lg font-bold text-gray-900">{employee.name}</p>
        <p className="text-sm text-gray-500">{employee.email}</p>
        <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-pink-100 text-pink-800">
          {role}
        </span>
      </div>
      <div className="mt-4 flex gap-4">
        <Link to={`/admin/hr/edit/${employee.uid}`} className="text-pink-600 hover:text-pink-900">
          Editar
        </Link>
        <button onClick={handleImpersonate} className="text-blue-600 hover:text-blue-900">
          Impersonate
        </button>
      </div>
    </div>
  );
}

export default function EmployeesPage({ setHrSection }: { setHrSection: (section: 'list' | 'new') => void }) {
  const [employees, setEmployees] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    const fetchEmployees = async () => {
      setLoading(true);
      const employees = await employeeService.getEmployees();
      console.log('here')
      setEmployees(employees);
      setLoading(false);
    };
    fetchEmployees();
  }, []);

  const filteredEmployees = useMemo(() => {
    return employees.filter(employee =>
      employee.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      employee.email.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [employees, searchTerm]);

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-800">Recursos Humanos</h1>
        <button onClick={() => setHrSection('new')} className="bg-pink-500 text-white px-4 py-2 rounded-lg hover:bg-pink-600">
          Adicionar Funcionário
        </button>
      </div>

      <div className="mb-4">
        <input
          type="text"
          placeholder="Pesquisar por nome ou email..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-pink-500"
        />
      </div>

      {loading ? (
        <p>A carregar...</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {filteredEmployees.map(employee => (
            <EmployeeCard key={employee.uid} employee={employee} />
          ))}
        </div>
      )}
    </div>
  );
}