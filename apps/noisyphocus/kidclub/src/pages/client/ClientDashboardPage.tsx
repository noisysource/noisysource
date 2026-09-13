import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import { col } from '../../lib/db';
import { grossFromAppliedDiscounts } from '../../services/discountService';
import { StudyRoomEntry, TransportationSubscription, Invoice } from '@shared/models';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';

const STATUS_PT: Record<string, string> = {
  paid: 'Paga', pending: 'Pendente', overdue: 'Em atraso',
  cancelled: 'Cancelada', canceled: 'Cancelada',
};

const STATUS_CLS: Record<string, string> = {
  paid: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800',
  overdue: 'bg-red-100 text-red-800',
};

const SUB_STATUS_PT: Record<string, string> = {
  active: 'Ativo', confirmed: 'Ativo',
  pending: 'Pendente', planned: 'Planeado', offered: 'Aguarda confirmação',
  cancelled: 'Cancelado', canceled: 'Cancelado',
  suspended: 'Suspenso',
};

export default function ClientDashboardPage() {
  const user = useUser();
  const [studySubscriptions, setStudySubscriptions] = useState<StudyRoomEntry[]>([]);
  const [transportSubscriptions, setTransportSubscriptions] = useState<TransportationSubscription[]>([]);
  const [recentInvoices, setRecentInvoices] = useState<Invoice[]>([]);
  const [invoiceSummary, setInvoiceSummary] = useState({ pending: 0, overdue: 0, totalPending: 0 });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (user) {
      const fetchData = async () => {
        setIsLoading(true);

        const studyQuery = query(col('studyroom'), where('userId', '==', user.uid));
        const studySnapshot = await getDocs(studyQuery);
        setStudySubscriptions(studySnapshot.docs.map(doc => ({ ...doc.data() as StudyRoomEntry, id: doc.id })));

        const transportQuery = query(col('transportationSubscriptions'), where('userId', '==', user.uid));
        const transportSnapshot = await getDocs(transportQuery);
        setTransportSubscriptions(transportSnapshot.docs.map(doc => ({ ...doc.data() as TransportationSubscription, id: doc.id })));

        const invoicesQuery = query(
          col('invoices'),
          where('userId', '==', user.uid),
          orderBy('issueDate', 'desc'),
          limit(5)
        );
        const invoicesSnapshot = await getDocs(invoicesQuery);
        const invoicesData = invoicesSnapshot.docs.map(doc => {
          const data = doc.data();
          return {
            ...data,
            id: doc.id,
            issueDate: data.issueDate?.toDate?.() || new Date(data.issueDate),
            dueDate: data.dueDate?.toDate?.() || new Date(data.dueDate),
            paidDate: data.paidDate?.toDate?.() || (data.paidDate ? new Date(data.paidDate) : undefined),
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
            updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
          } as Invoice;
        });
        setRecentInvoices(invoicesData);

        const allInvoicesQuery = query(col('invoices'), where('userId', '==', user.uid));
        const allInvoicesSnapshot = await getDocs(allInvoicesQuery);
        let pendingCount = 0, overdueCount = 0, totalPendingAmount = 0;

        allInvoicesSnapshot.docs.forEach(doc => {
          const data = doc.data();
          const invoice = {
            ...data,
            status: data.status,
            dueDate: data.dueDate?.toDate?.() || new Date(data.dueDate),
            total: data.total || 0,
          } as Invoice;
          if (invoice.status === 'pending') {
            pendingCount++;
            if (new Date() > invoice.dueDate) overdueCount++;
            totalPendingAmount += invoice.total;
          }
        });

        setInvoiceSummary({ pending: pendingCount, overdue: overdueCount, totalPending: totalPendingAmount });
        setIsLoading(false);
      };
      fetchData();
    }
  }, [user]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">A carregar...</div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Início</h1>

      {/* Invoice summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Link to="/client/invoices" className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Faturas pendentes</p>
              <p className="text-2xl font-bold mt-1">{invoiceSummary.pending}</p>
            </div>
            <div className="text-blue-600 text-3xl">📄</div>
          </div>
        </Link>
        <Link to="/client/invoices" className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Em atraso</p>
              <p className="text-2xl font-bold mt-1 text-red-600">{invoiceSummary.overdue}</p>
            </div>
            <div className="text-red-600 text-3xl">⚠️</div>
          </div>
        </Link>
        <Link to="/client/invoices" className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total em dívida</p>
              <p className="text-2xl font-bold mt-1">€{invoiceSummary.totalPending.toFixed(2)}</p>
            </div>
            <div className="text-yellow-600 text-3xl">💶</div>
          </div>
        </Link>
      </div>

      {/* Recent invoices */}
      {recentInvoices.length > 0 && (
        <div className="mb-8">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold">Faturas recentes</h2>
            <Link to="/client/invoices" className="text-blue-600 hover:underline text-sm">
              Ver todas →
            </Link>
          </div>
          <div className="space-y-2">
            {recentInvoices.map(invoice => (
              <Link
                key={invoice.id}
                to={`/client/invoices/${invoice.id}`}
                className="block bg-white p-4 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow"
              >
                <div className="flex justify-between items-center">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">Fatura {invoice.invoiceNumber}</span>
                      <span className={`px-2 py-1 rounded text-xs ${STATUS_CLS[invoice.status] ?? 'bg-gray-100 text-gray-800'}`}>
                        {STATUS_PT[invoice.status] ?? invoice.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      {format(invoice.issueDate, 'dd/MM/yyyy')} · Vence {format(invoice.dueDate, 'dd/MM/yyyy')}
                    </p>
                  </div>
                  <div className="text-right shrink-0 ml-4">
                    <div className="text-lg font-bold">€{invoice.total.toFixed(2)}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Study room subscriptions */}
      <div className="mb-8">
        <h2 className="text-xl font-bold mb-4">Sala de Estudo</h2>
        {studySubscriptions.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {studySubscriptions.map(sub => (
              <div key={sub.id} className="p-4 bg-white border border-gray-200 rounded-lg shadow-sm">
                <p className="font-bold">{sub.childName}</p>
                <p className="text-sm text-gray-600">{SUB_STATUS_PT[sub.status ?? ''] ?? sub.status}</p>
                <p className="text-lg font-semibold mt-1">
                  {(sub.basePrice ?? 0) > sub.monthlyPrice + 0.01
                    ? <><span className="line-through text-gray-400 text-sm font-normal">€{(sub.basePrice!).toFixed(2)}</span>{' '}<span className="text-green-700">€{sub.monthlyPrice.toFixed(2)}</span>/mês</>
                    : `€${sub.monthlyPrice.toFixed(2)}/mês`}
                </p>
                <Link to={`/client/study/${sub.id}`} className="text-blue-500 hover:underline text-sm mt-2 inline-block">
                  Ver detalhes
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500">Não tem inscrições na Sala de Estudo.</p>
        )}
      </div>

      {/* Transport subscriptions */}
      <div className="mb-8">
        <h2 className="text-xl font-bold mb-4">Transporte Escolar</h2>
        {transportSubscriptions.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {transportSubscriptions.map(sub => (
              <div key={sub.id} className="p-4 bg-white border border-gray-200 rounded-lg shadow-sm hover:shadow-md transition-shadow">
                <p className="font-bold">{sub.childName}</p>
                <p className="text-sm text-gray-600">{SUB_STATUS_PT[sub.status ?? ''] ?? sub.status}</p>
                <p className="text-lg font-semibold mt-2">
                  {(() => { const g = grossFromAppliedDiscounts(sub.monthlyFee, sub.appliedDiscounts); return g != null && g > sub.monthlyFee + 0.01 ? <><span className="line-through text-gray-400 text-sm font-normal">€{g.toFixed(2)}</span>{' '}<span className="text-green-700">€{sub.monthlyFee.toFixed(2)}</span>/mês</> : `€${sub.monthlyFee.toFixed(2)}/mês`; })()}
                </p>
                <Link to={`/client/transport/${sub.id}`} className="text-blue-500 hover:underline text-sm mt-2 inline-block">
                  Ver detalhes
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <p className="text-gray-500">Não tem inscrições de transporte.</p>
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="mt-8 pt-8 border-t">
        <h2 className="text-xl font-bold mb-4">Acesso rápido</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link
            to="/client/invoices"
            className="bg-blue-50 hover:bg-blue-100 p-4 rounded-lg border border-blue-200 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="text-2xl">📄</div>
              <div>
                <div className="font-semibold">Todas as faturas</div>
                <div className="text-sm text-gray-600">Consultar histórico de faturação</div>
              </div>
            </div>
          </Link>
          <Link
            to="/client/family/payments"
            className="bg-green-50 hover:bg-green-100 p-4 rounded-lg border border-green-200 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="text-2xl">💳</div>
              <div>
                <div className="font-semibold">Pagamentos</div>
                <div className="text-sm text-gray-600">Ver histórico de pagamentos</div>
              </div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
