import React, { useEffect, useState, useMemo } from 'react';
import { collection, getDocs, updateDoc, deleteDoc, doc } from 'firebase/firestore';
import { TransportationSubscription, SubscriptionSchedule, SubscriptionStatus } from '@shared/models/Transportation';
import { db } from '../../../lib/firebase';
import ReactPaginate from 'react-paginate';

type Editable<T> = T & { id: string; isEditing?: boolean };

const ScheduleDetails = ({ schedule }: { schedule: SubscriptionSchedule[] }) => {
  const groupedSchedule = useMemo(() => {
    return schedule.reduce<Record<string, SubscriptionSchedule[]>>((acc, trip) => {
      const day = trip.dayOfWeek;
      if (!acc[day]) {
        acc[day] = [];
      }
      acc[day].push(trip);
      return acc;
    }, {});
  }, [schedule]);

  const dayOrder = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

  return (
    <div className="p-2 bg-white rounded-md shadow-inner">
      {Object.keys(groupedSchedule).sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b)).map(day => (
        <div key={day} className="mb-3">
          <h5 className="text-sm font-bold capitalize text-gray-800 border-b pb-1 mb-2">{day}</h5>
          <div className="grid grid-cols-10 gap-x-4 text-xs font-semibold text-gray-500 px-2">
            <div className="col-span-2">Hora</div>
            <div className="col-span-4">Recolha</div>
            <div className="col-span-4">Entrega</div>
          </div>
          <div className="space-y-1 mt-1">
            {groupedSchedule[day].map((trip, index) => (
              <div key={index} className="grid grid-cols-10 gap-x-4 text-xs p-2 rounded-md even:bg-gray-50 items-center">
                <div className="col-span-2 font-medium">{trip.pickupTime}</div>
                <div className="col-span-4">{trip.pickupLocation}</div>
                <div className="col-span-4">{trip.dropoffLocation}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

const statusTabs: { key: SubscriptionStatus; label: string }[] = [
    { key: 'pending', label: 'Pendente' },
    { key: 'active', label: 'Ativo' },
    { key: 'inactive', label: 'Inativo' },
    { key: 'cancelled', label: 'Cancelado' },
];


export default function AdminTransportationSubscriptions() {
  const [subscriptions, setSubscriptions] = useState<Editable<TransportationSubscription>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [activeTab, setActiveTab] = useState<SubscriptionStatus>('pending');

  useEffect(() => {
    const fetchSubscriptions = async () => {
      try {
        const subsSnapshot = await getDocs(collection(db, 'transportationSubscriptions'));
        const subsList: Editable<TransportationSubscription>[] = subsSnapshot.docs.map(d => ({
          ...d.data() as TransportationSubscription,
          id: d.id,
        }));
        setSubscriptions(subsList);
      } catch (err) {
        console.error("Error fetching transportation subscriptions:", err);
        setError("Erro ao carregar subscrições de transporte.");
      } finally {
        setLoading(false);
      }
    };
    fetchSubscriptions();
  }, []);

  const handleUpdateSubscription = async (sub: Editable<TransportationSubscription>) => {
    if (!sub.id) return;
    try {
      const { id, isEditing, ...dataToUpdate } = sub;
      await updateDoc(doc(db, 'transportationSubscriptions', id), { ...dataToUpdate, updatedAt: new Date() });
      setSubscriptions(prev => prev.map(s => s.id === id ? { ...s, isEditing: false } : s));
    } catch (err) {
      console.error("Error updating subscription:", err);
      setError("Erro ao atualizar subscrição.");
    }
  };

  const handleDeleteSubscription = async (id: string) => {
    if (window.confirm('Tem a certeza que quer apagar esta subscrição?')) {
      try {
        await deleteDoc(doc(db, 'transportationSubscriptions', id));
        setSubscriptions(prev => prev.filter(s => s.id !== id));
      } catch (err) {
        console.error("Error deleting subscription:", err);
        setError("Erro ao apagar subscrição.");
      }
    }
  };

  const handleSubscriptionChange = (id: string, field: keyof TransportationSubscription, value: any) => {
    setSubscriptions(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s));
  };

  const toggleEdit = (id: string) => {
    setSubscriptions(prev => prev.map(s => s.id === id ? { ...s, isEditing: !s.isEditing } : s));
  };

  const handleStatusUpdate = async (id: string, status: SubscriptionStatus) => {
    try {
      await updateDoc(doc(db, 'transportationSubscriptions', id), { status, updatedAt: new Date() });
      setSubscriptions(prev => prev.map(s => s.id === id ? { ...s, status } : s));
    } catch (err) {
      console.error("Error updating subscription status:", err);
      setError("Erro ao atualizar o estado da subscrição.");
    }
  };

  const filteredSubscriptions = subscriptions
    .filter(sub => sub.status === activeTab)
    .filter(sub =>
        ((sub as any).parentName || sub.childName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        ((sub as any).studentName || sub.childName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        sub.contactEmail.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const pageCount = Math.ceil(filteredSubscriptions.length / itemsPerPage);
  const offset = currentPage * itemsPerPage;
  const currentPageData = filteredSubscriptions.slice(offset, offset + itemsPerPage);

  const handlePageClick = ({ selected }: { selected: number }) => {
    setCurrentPage(selected);
  };

  if (loading) return <div className="p-4">A carregar subscrições de transporte...</div>;
  if (error) return <div className="p-4 text-red-500">{error}</div>;

  return (
    <div className="p-4 space-y-6">
        <div className="flex justify-between items-center">
            <h2 className="text-2xl font-bold text-gray-800">📝 Gestão de Subscrições de Transporte</h2>
            <input type="text" placeholder="Pesquisar..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="w-1/3 px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm" />
        </div>

        <div className="mb-6 border-b border-gray-200">
            <ul className="flex flex-wrap -mb-px text-base font-medium text-center" role="tablist">
                {statusTabs.map(tab => (
                    <li key={tab.key} className="me-2" role="presentation">
                        <button
                        className={`inline-block p-4 border-b-2 rounded-t-lg transition-colors duration-200 ${activeTab === tab.key ? "text-blue-600 border-blue-600" : "text-gray-500 hover:text-gray-700 hover:border-gray-300"}`}
                        onClick={() => setActiveTab(tab.key)}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab.key}
                        >
                        {tab.label}
                        </button>
                    </li>
                ))}
            </ul>
        </div>

      <div className="overflow-x-auto">
        <table className="min-w-full bg-white shadow-md rounded-lg">
          <thead>
            <tr className="bg-gray-200 text-gray-600 uppercase text-sm leading-normal">
              <th className="py-3 px-6 text-left">Responsável</th>
              <th className="py-3 px-6 text-left">Aluno</th>
              <th className="py-3 px-6 text-left">Contacto</th>
              <th className="py-3 px-6 text-left">Início</th>
              <th className="py-3 px-6 text-left">Preço</th>
              <th className="py-3 px-6 text-left">Status</th>
              <th className="py-3 px-6 text-center">Ações</th>
            </tr>
          </thead>
          <tbody className="text-gray-600 text-sm font-light">
            {currentPageData.map(sub => (
              <React.Fragment key={sub.id}>
                <tr className="border-b border-gray-200 hover:bg-gray-100 cursor-pointer" onClick={() => setExpandedRow(expandedRow === sub.id ? null : sub.id)}>
                  <td className="py-3 px-6 text-left">{(sub as any).parentName || sub.childName}</td>
                  <td className="py-3 px-6 text-left">{(sub as any).studentName || sub.childName}</td>
                  <td className="py-3 px-6 text-left">{sub.contactEmail}<br/>{sub.contactMobile}</td>
                  <td className="py-3 px-6 text-left">{sub.startDate}</td>
                  <td className="py-3 px-6 text-left">€{sub.monthlyFee.toFixed(2)}</td>
                  <td className="py-3 px-6 text-left">
                    {sub.isEditing ? (
                      <select value={sub.status} onChange={e => handleSubscriptionChange(sub.id, 'status', e.target.value)} className="w-full border-gray-300 rounded-md shadow-sm text-sm">
                        <option value="pending">Pendente</option>
                        <option value="active">Ativo</option>
                        <option value="inactive">Inativo</option>
                        <option value="cancelled">Cancelado</option>
                      </select>
                    ) : (
                      sub.status
                    )}
                  </td>
                  <td className="py-3 px-6 text-center">
                  <div className="flex item-center justify-center">
                    {sub.status === 'pending' && (
                        <>
                            <button onClick={(e) => { e.stopPropagation(); handleStatusUpdate(sub.id, 'active'); }} className="bg-green-500 text-white px-3 py-1 rounded-md text-xs mr-2">Aprovar</button>
                            <button onClick={(e) => { e.stopPropagation(); handleStatusUpdate(sub.id, 'cancelled'); }} className="bg-red-500 text-white px-3 py-1 rounded-md text-xs mr-2">Rejeitar</button>
                        </>
                    )}
                    {sub.isEditing ? (
                        <button onClick={(e) => { e.stopPropagation(); handleUpdateSubscription(sub); }} className="bg-blue-500 text-white px-3 py-1 rounded-md text-xs mr-2">Guardar</button>
                    ) : (
                        <button onClick={(e) => { e.stopPropagation(); toggleEdit(sub.id); }} className="bg-yellow-500 text-white px-3 py-1 rounded-md text-xs mr-2">Editar</button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteSubscription(sub.id); }} className="bg-red-600 text-white px-3 py-1 rounded-md text-xs">Apagar</button>
                    </div>
                  </td>
                </tr>
                {expandedRow === sub.id && (
                  <tr className="bg-gray-50">
                    <td colSpan={7} className="p-4">
                      <h4 className="font-semibold text-sm mb-2">Horário Semanal:</h4>
                      {sub.schedule ? <ScheduleDetails schedule={sub.schedule} /> : <p className="text-xs text-gray-500">Sem horário definido.</p>}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
        <ReactPaginate
            previousLabel={String.fromCharCode(60)}
            nextLabel={String.fromCharCode(62)}
            breakLabel={'...'}
            pageCount={pageCount}
            marginPagesDisplayed={2}
            pageRangeDisplayed={5}
            onPageChange={handlePageClick}
            containerClassName={'flex justify-center items-center space-x-2 mt-4'}
            pageClassName={'px-3 py-1 rounded-md cursor-pointer'}
            pageLinkClassName={'text-gray-700'}
            previousClassName={'px-3 py-1 rounded-md cursor-pointer'}
            previousLinkClassName={'text-gray-700'}
            nextClassName={'px-3 py-1 rounded-md cursor-pointer'}
            nextLinkClassName={'text-gray-700'}
            breakClassName={'px-3 py-1 rounded-md cursor-pointer'}
            breakLinkClassName={'text-gray-700'}
            activeClassName={'bg-pink-500 text-white'}
        />
    </div>
  );
}