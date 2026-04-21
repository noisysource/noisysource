import { useState } from 'react';
import { AppUser } from '@shared/models';

interface GenerateTimesheetModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGenerate: (date: Date, teacherId: string, endTime: string) => void;
  employees: AppUser[];
}

export default function GenerateTimesheetModal({ isOpen, onClose, onGenerate, employees }: GenerateTimesheetModalProps) {
  const [date, setDate] = useState(new Date());
  const [teacherId, setTeacherId] = useState('');
  const [endTime, setEndTime] = useState('19:00');

  const handleGenerate = () => {
    if (!teacherId) {
      alert('Please select a teacher.');
      return;
    }
    onGenerate(date, teacherId, endTime);
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 shadow-xl w-full max-w-md">
        <h2 className="text-2xl font-bold mb-4">Gerar Registo de Horas Automático</h2>
        <div className="space-y-4">
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
            <label className="block font-medium">Professor(a)</label>
            <select
              value={teacherId}
              onChange={e => setTeacherId(e.target.value)}
              className="w-full border rounded px-3 py-2 mt-1"
              required
            >
              <option value="">Selecione um professor(a)</option>
              {employees.map(emp => (
                <option key={emp.uid} value={emp.uid}>{emp.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block font-medium">Hora de Fim</label>
            <input
              type="time"
              value={endTime}
              onChange={e => setEndTime(e.target.value)}
              className="w-full border rounded px-3 py-2 mt-1"
              required
            />
          </div>
        </div>
        <div className="flex justify-end space-x-4 mt-6">
          <button type="button" onClick={onClose} className="bg-gray-300 text-gray-800 px-4 py-2 rounded hover:bg-gray-400">
            Cancelar
          </button>
          <button type="button" onClick={handleGenerate} className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
            Gerar
          </button>
        </div>
      </div>
    </div>
  );
}
