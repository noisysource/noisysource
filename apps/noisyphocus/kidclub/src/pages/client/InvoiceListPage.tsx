import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { getDocs, query, where } from 'firebase/firestore';
import { col } from '../../lib/db';
import { Invoice } from '@shared/models';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';

export default function InvoiceListPage() {
  const user = useUser();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('all');

  useEffect(() => {
    if (user) {
      const fetchInvoices = async () => {
        setIsLoading(true);
        const invoicesQuery = query(
          col('invoices'),
          where('userId', '==', user.uid),
        );
        const snapshot = await getDocs(invoicesQuery);
        const invoicesData = snapshot.docs.map(doc => {
          const data = doc.data();
          return {
            ...data,
            id: doc.id,
            issueDate: data.issueDate?.toDate?.() || new Date(data.issueDate),
            dueDate: data.dueDate?.toDate?.() || new Date(data.dueDate),
            paidDate: data.paidDate?.toDate?.() || (data.paidDate ? new Date(data.paidDate) : undefined),
            periodStart: data.periodStart?.toDate?.() || (data.periodStart ? new Date(data.periodStart) : undefined),
            periodEnd: data.periodEnd?.toDate?.() || (data.periodEnd ? new Date(data.periodEnd) : undefined),
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
            updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
          } as Invoice;
        });
        invoicesData.sort((a, b) => b.issueDate.getTime() - a.issueDate.getTime());
        setInvoices(invoicesData);
        setIsLoading(false);
      };

      fetchInvoices();
    }
  }, [user]);

  const filteredInvoices = filterStatus === 'all' 
    ? invoices 
    : invoices.filter(inv => inv.status === filterStatus);

  const getStatusColor = (status: Invoice['status']) => {
    switch (status) {
      case 'paid':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'overdue':
        return 'bg-red-100 text-red-800';
      case 'cancelled':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-blue-100 text-blue-800';
    }
  };

  const getSubscriptionLabel = (invoice: Invoice) => {
    const types = invoice.subscriptionItems?.map(i => i.subscriptionType) ?? [];
    if (types.includes('study') && types.includes('transport')) return 'Study Room & Transport';
    if (types.includes('study')) return 'Study Room';
    if (types.includes('transport')) return 'Transport';
    return 'Services';
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">Loading invoices...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">As minhas faturas</h1>
      </div>

      {/* Filters */}
      <div className="mb-6 flex gap-2 flex-wrap">
        <button
          onClick={() => setFilterStatus('all')}
          className={`px-4 py-2 rounded-lg ${
            filterStatus === 'all' 
              ? 'bg-blue-600 text-white' 
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          Todas
        </button>
        <button
          onClick={() => setFilterStatus('pending')}
          className={`px-4 py-2 rounded-lg ${
            filterStatus === 'pending'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          Pendentes
        </button>
        <button
          onClick={() => setFilterStatus('paid')}
          className={`px-4 py-2 rounded-lg ${
            filterStatus === 'paid'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          Pagas
        </button>
        <button
          onClick={() => setFilterStatus('overdue')}
          className={`px-4 py-2 rounded-lg ${
            filterStatus === 'overdue' 
              ? 'bg-blue-600 text-white' 
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          Em atraso
        </button>
      </div>

      {/* Invoice List */}
      {filteredInvoices.length > 0 ? (
        <div className="space-y-4">
          {filteredInvoices.map(invoice => (
            <Link
              key={invoice.id}
              to={`/client/invoices/${invoice.id}`}
              className="block"
            >
              <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold">
                        Fatura {invoice.invoiceNumber}
                      </h3>
                      <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(invoice.status)}`}>
                        {(({ paid: 'Paga', pending: 'Pendente', overdue: 'Em atraso', cancelled: 'Cancelada', draft: 'Rascunho', refunded: 'Reembolsada' } as Record<string, string>)[invoice.status]) ?? invoice.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 mb-2">
                      {getSubscriptionLabel(invoice)}
                    </p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500">
                      <span>Emitida: {format(invoice.issueDate, 'dd/MM/yyyy')}</span>
                      <span>Vencimento: {format(invoice.dueDate, 'dd/MM/yyyy')}</span>
                      {invoice.periodStart && invoice.periodEnd && (
                        <span>
                          Período: {format(invoice.periodStart, 'dd/MM')} – {format(invoice.periodEnd, 'dd/MM/yyyy')}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-gray-900">
                      €{invoice.total.toFixed(2)}
                    </div>
                    <div className="text-sm text-gray-500 mt-1">
                      {invoice.currency}
                    </div>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
          <p className="text-gray-500">
            {filterStatus === 'all'
              ? 'Ainda não tem faturas.'
              : 'Nenhuma fatura encontrada para este filtro.'}
          </p>
        </div>
      )}
    </div>
  );
}












