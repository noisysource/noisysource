import { useState } from 'react';
import AdminTransportationSubscriptions from '../../../components/admin/transport/AdminTransportationSubscriptions';

import AdminTransportationPlanner from '../../../components/admin/transport/AdminTransportationPlanner';

type TransportSection = 'subscriptions' | 'planning';

const TABS: { key: TransportSection; label: string }[] = [
  { key: 'subscriptions', label: 'Subscrições' },
  { key: 'planning', label: 'Planeamento' },
];

export default function TransportationPage() {
  const [section, setSection] = useState<TransportSection>('subscriptions');

  const renderSection = () => {
    switch (section) {
      case 'subscriptions':
        return <AdminTransportationSubscriptions />;
      case 'planning':
        return <AdminTransportationPlanner />;
      default:
        return null;
    }
  };

  return (
    <div className="p-4">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">🚚 Gestão de Transportes</h1>
      <div className="border-b border-gray-200 mb-4">
        <nav className="-mb-px flex space-x-8" aria-label="Tabs">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setSection(tab.key)}
              className={`${
                section === tab.key
                  ? 'border-purple-500 text-purple-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
              aria-current={section === tab.key ? 'page' : undefined}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>
      <div>{renderSection()}</div>
    </div>
  );
}