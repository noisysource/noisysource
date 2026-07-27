import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { db } from '../../lib/firebase';
import { collection, getDocs, query, where, doc, getDoc, addDoc } from 'firebase/firestore';
import { Family, Invoice, Payment, Child } from '@shared/models';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';

export default function FamilyInvoicePage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [children, setChildren] = useState<Child[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('all');

  useEffect(() => {
    if (user) {
      fetchFamilyInvoices();
    }
  }, [user]);

  const fetchFamilyInvoices = async () => {
    if (!user) return;
    setIsLoading(true);
    try {
      const familiesQuery = query(
        collection(db, 'families'),
        where('primaryContact.userId', '==', user.uid)
      );
      const familiesSnapshot = await getDocs(familiesQuery);

      if (familiesSnapshot.empty) {
        // Auto-create family if it doesn't exist
        const newFamily: Omit<Family, 'id'> = {
          primaryContact: {
            name: user.name || user.email?.split('@')[0] || 'User',
            email: user.email || '',
            phone: '',
            userId: user.uid,
          },
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const familyRef = await addDoc(collection(db, 'families'), newFamily);
        const familyData = {
          ...newFamily,
          id: familyRef.id,
        } as Family;
        setFamily(familyData);
        setInvoices([]);
        setChildren([]);
        setIsLoading(false);
        return;
      }

      if (!familiesSnapshot.empty) {
        const familyData = {
          ...familiesSnapshot.docs[0].data(),
          id: familiesSnapshot.docs[0].id,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as Family;
        setFamily(familyData);

        const familyId = familyData.id;

        // Fetch invoices
        const invoicesQuery = query(
          collection(db, 'invoices'),
          where('familyId', '==', familyId)
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
            periodStart: data.periodStart?.toDate?.() || new Date(data.periodStart),
            periodEnd: data.periodEnd?.toDate?.() || new Date(data.periodEnd),
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
            updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
          } as Invoice;
        });
        setInvoices(invoicesData.sort((a, b) => b.issueDate.getTime() - a.issueDate.getTime()));

        // Fetch children for display
        const childrenQuery = query(
          collection(db, 'children'),
          where('familyId', '==', familyId)
        );
        const childrenSnapshot = await getDocs(childrenQuery);
        setChildren(childrenSnapshot.docs.map(doc => ({ ...doc.data(), id: doc.id } as Child)));
      }
    } catch (error) {
      console.error('Error fetching invoices:', error);
    } finally {
      setIsLoading(false);
    }
  };

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

  // Calculate totals
  const pendingTotal = invoices
    .filter(inv => inv.status === 'pending')
    .reduce((sum, inv) => sum + inv.total, 0);

  const overdueCount = invoices.filter(inv => {
    return inv.status === 'pending' && new Date() > inv.dueDate;
  }).length;

  if (isLoading) {
    return <div className="flex justify-center items-center h-64"><div className="text-gray-500">Loading...</div></div>;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Family Invoices</h1>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
          <p className="text-sm text-gray-600">Pending Invoices</p>
          <p className="text-2xl font-bold mt-1">
            {invoices.filter(inv => inv.status === 'pending').length}
          </p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
          <p className="text-sm text-gray-600">Overdue</p>
          <p className="text-2xl font-bold mt-1 text-red-600">{overdueCount}</p>
        </div>
        <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
          <p className="text-sm text-gray-600">Total Pending</p>
          <p className="text-2xl font-bold mt-1">€{pendingTotal.toFixed(2)}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 flex gap-2 flex-wrap">
        <button
          onClick={() => setFilterStatus('all')}
          className={`px-4 py-2 rounded-lg text-sm ${filterStatus === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
        >
          All
        </button>
        <button
          onClick={() => setFilterStatus('pending')}
          className={`px-4 py-2 rounded-lg text-sm ${filterStatus === 'pending' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
        >
          Pending
        </button>
        <button
          onClick={() => setFilterStatus('paid')}
          className={`px-4 py-2 rounded-lg text-sm ${filterStatus === 'paid' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
        >
          Paid
        </button>
        <button
          onClick={() => setFilterStatus('overdue')}
          className={`px-4 py-2 rounded-lg text-sm ${filterStatus === 'overdue' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
        >
          Overdue
        </button>
      </div>

      {/* Invoice List */}
      {filteredInvoices.length > 0 ? (
        <div className="space-y-4">
          {filteredInvoices.map(invoice => {
            const isOverdue = invoice.status === 'pending' && new Date() > invoice.dueDate;

            return (
              <Link
                key={invoice.id}
                to={`/client/family/invoices/${invoice.id}`}
                className="block"
              >
                <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="text-lg font-semibold">
                          Invoice {invoice.invoiceNumber}
                        </h3>
                        <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(invoice.status)}`}>
                          {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                          {isOverdue && ' (Overdue)'}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mb-2">
                        Period: {format(invoice.periodStart, 'MMM dd')} - {format(invoice.periodEnd, 'MMM dd, yyyy')}
                      </p>
                      <div className="flex gap-4 text-sm text-gray-500">
                        <span>Issue Date: {format(invoice.issueDate, 'MMM dd, yyyy')}</span>
                        <span>Due Date: {format(invoice.dueDate, 'MMM dd, yyyy')}</span>
                      </div>
                      {/* Show children included */}
                      {invoice.subscriptionItems && invoice.subscriptionItems.length > 0 && (
                        <div className="mt-2 text-sm text-gray-600">
                          Services for: {Array.from(new Set(invoice.subscriptionItems.map(item => item.childName))).join(', ')}
                        </div>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold text-gray-900">
                        €{invoice.total.toFixed(2)}
                      </div>
                      <div className="text-sm text-gray-500 mt-1">{invoice.currency}</div>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
          <p className="text-gray-500">
            {filterStatus === 'all' ? 'No invoices yet.' : `No ${filterStatus} invoices found.`}
          </p>
        </div>
      )}
    </div>
  );
}

