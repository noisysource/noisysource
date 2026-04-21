import { useState } from 'react';
import EmployeesPage from './EmployeesPage';
import NewEmployeePage from './NewEmployeePage';

export default function HRPage() {
  const [hrSection, setHrSection] = useState<'list' | 'new'>('list');

  if (hrSection === 'list') {
    return <EmployeesPage setHrSection={setHrSection} />;
  }

  return <NewEmployeePage setHrSection={setHrSection} />;
}
