import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { db } from '../../lib/firebase';
import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import { StudyRoomEntry, TransportationSubscription, Invoice } from '@shared/models';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';

export default function ClientDashboardPage() {
  const user = useUser();
  const [studySubscriptions, setStudySubscriptions] = useState<StudyRoomEntry[]>([]);
  const [transportSubscriptions, setTransportSubscriptions] = useState<TransportationSubscription[]>([]);
  const [recentInvoices, setRecentInvoices] = useState<Invoice[]>([]);
  const [invoiceSummary, setInvoiceSummary] = useState({
    pending: 0,
    overdue: 0,
    totalPending: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (user) {
      const fetchData = async () => {
        setIsLoading(true);

        // Fetch study room subscriptions
        const studyQuery = query(collection(db, 'studyroom'), where('userId', '==', user.uid));
        const studySnapshot = await getDocs(studyQuery);
        setStudySubscriptions(studySnapshot.docs.map(doc => ({ ...doc.data() as StudyRoomEntry, id: doc.id })));

        // Fetch transport subscriptions
        const transportQuery = query(collection(db, 'transportationSubscriptions'), where('userId', '==', user.uid));
        const transportSnapshot = await getDocs(transportQuery);
        setTransportSubscriptions(transportSnapshot.docs.map(doc => ({ ...doc.data() as TransportationSubscription, id: doc.id })));

        // Fetch recent invoices
        const invoicesQuery = query(
          collection(db, 'invoices'),
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

        // Calculate invoice summary
        const allInvoicesQuery = query(
          collection(db, 'invoices'),
          where('userId', '==', user.uid)
        );
        const allInvoicesSnapshot = await getDocs(allInvoicesQuery);
        let pendingCount = 0;
        let overdueCount = 0;
        let totalPendingAmount = 0;

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
            const isOverdue = new Date() > invoice.dueDate;
            if (isOverdue) {
              overdueCount++;
            }
            totalPendingAmount += invoice.total;
          }
        });

        setInvoiceSummary({
          pending: pendingCount,
          overdue: overdueCount,
          totalPending: totalPendingAmount,
        });

        setIsLoading(false);
      };

      fetchData();
    }
  }, [user]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  const getStatusColor = (status: Invoice['status']) => {
    switch (status) {
      case 'paid':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'overdue':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">My Dashboard</h1>

      {/* Invoice Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Link to="/client/invoices" className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Pending Invoices</p>
              <p className="text-2xl font-bold mt-1">{invoiceSummary.pending}</p>
            </div>
            <div className="text-blue-600 text-3xl">📄</div>
          </div>
        </Link>
        <Link to="/client/invoices" className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Overdue</p>
              <p className="text-2xl font-bold mt-1 text-red-600">{invoiceSummary.overdue}</p>
            </div>
            <div className="text-red-600 text-3xl">⚠️</div>
          </div>
        </Link>
        <Link to="/client/invoices" className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Pending</p>
              <p className="text-2xl font-bold mt-1">€{invoiceSummary.totalPending.toFixed(2)}</p>
            </div>
            <div className="text-yellow-600 text-3xl">💶</div>
          </div>
        </Link>
      </div>

      {/* Recent Invoices */}
      {recentInvoices.length > 0 && (
        <div className="mb-8">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold">Recent Invoices</h2>
            <Link to="/client/invoices" className="text-blue-600 hover:underline text-sm">
              View All →
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
                    <div className="flex items-center gap-2">
                      <span className="font-medium">Invoice {invoice.invoiceNumber}</span>
                      <span className={`px-2 py-1 rounded text-xs ${getStatusColor(invoice.status)}`}>
                        {invoice.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      {format(invoice.issueDate, 'MMM dd, yyyy')} · Due {format(invoice.dueDate, 'MMM dd, yyyy')}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold">€{invoice.total.toFixed(2)}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Subscriptions */}
      <div className="mb-8">
        <h2 className="text-xl font-bold mb-4">My Study Room Subscriptions</h2>
        {studySubscriptions.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {studySubscriptions.map(sub => (
              <div key={sub.id} className="p-4 border rounded-lg shadow-sm">
                <p className="font-bold">{sub.childName}</p>
                <p>Status: {sub.status}</p>
                <p>Price: €{sub.monthlyPrice.toFixed(2)}</p>
                <Link to={`/client/study/${sub.id}`} className="text-blue-500 hover:underline">View Details</Link>
              </div>
            ))}
          </div>
        ) : (
          <p>You have no study room subscriptions.</p>
        )}
      </div>

      <div>
        <h2 className="text-xl font-bold mb-4">My Transport Subscriptions</h2>
        {transportSubscriptions.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {transportSubscriptions.map(sub => (
              <div key={sub.id} className="p-4 bg-white border rounded-lg shadow-sm hover:shadow-md transition-shadow">
                <p className="font-bold">{sub.childName}</p>
                <p className="text-sm text-gray-600">Status: <span className="capitalize">{sub.status}</span></p>
                <p className="text-lg font-semibold mt-2">€{sub.monthlyFee.toFixed(2)}/month</p>
                <Link to={`/client/transport/${sub.id}`} className="text-blue-500 hover:underline text-sm mt-2 inline-block">View Details</Link>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <p className="text-gray-500">You have no transport subscriptions.</p>
          </div>
        )}
      </div>

      {/* Quick Links */}
      <div className="mt-8 pt-8 border-t">
        <h2 className="text-xl font-bold mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link
            to="/client/invoices"
            className="bg-blue-50 hover:bg-blue-100 p-4 rounded-lg border border-blue-200 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="text-2xl">📄</div>
              <div>
                <div className="font-semibold">View All Invoices</div>
                <div className="text-sm text-gray-600">See your billing history</div>
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
                <div className="font-semibold">Payment History</div>
                <div className="text-sm text-gray-600">Track your payments</div>
              </div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
