import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { Invoice, Payment } from '@shared/models';
import { format } from 'date-fns';

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (id) {
      const fetchInvoice = async () => {
        setIsLoading(true);
        
        // Fetch invoice
        const invoiceRef = doc(db, 'invoices', id);
        const invoiceSnap = await getDoc(invoiceRef);
        
        if (invoiceSnap.exists()) {
          const data = invoiceSnap.data();
          const invoiceData = {
            ...data,
            id: invoiceSnap.id,
            issueDate: data.issueDate?.toDate?.() || new Date(data.issueDate),
            dueDate: data.dueDate?.toDate?.() || new Date(data.dueDate),
            paidDate: data.paidDate?.toDate?.() || (data.paidDate ? new Date(data.paidDate) : undefined),
            periodStart: data.periodStart?.toDate?.() || (data.periodStart ? new Date(data.periodStart) : undefined),
            periodEnd: data.periodEnd?.toDate?.() || (data.periodEnd ? new Date(data.periodEnd) : undefined),
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
            updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
          } as Invoice;
          setInvoice(invoiceData);

          // Fetch associated payment if exists
          if (invoiceData.paymentId) {
            const paymentRef = doc(db, 'payments', invoiceData.paymentId);
            const paymentSnap = await getDoc(paymentRef);
            if (paymentSnap.exists()) {
              const paymentData = paymentSnap.data();
              setPayment({
                ...paymentData,
                id: paymentSnap.id,
                paymentDate: paymentData.paymentDate?.toDate?.() || new Date(paymentData.paymentDate),
                processedDate: paymentData.processedDate?.toDate?.() || (paymentData.processedDate ? new Date(paymentData.processedDate) : undefined),
                refundDate: paymentData.refundDate?.toDate?.() || (paymentData.refundDate ? new Date(paymentData.refundDate) : undefined),
                createdAt: paymentData.createdAt?.toDate?.() || new Date(paymentData.createdAt),
                updatedAt: paymentData.updatedAt?.toDate?.() || new Date(paymentData.updatedAt),
              } as Payment);
            }
          } else {
            // Check if there's a payment linked to this invoice
            const paymentsQuery = query(
              collection(db, 'payments'),
              where('invoiceId', '==', invoiceSnap.id)
            );
            const paymentsSnap = await getDocs(paymentsQuery);
            if (!paymentsSnap.empty) {
              const paymentData = paymentsSnap.docs[0].data();
              setPayment({
                ...paymentData,
                id: paymentsSnap.docs[0].id,
                paymentDate: paymentData.paymentDate?.toDate?.() || new Date(paymentData.paymentDate),
                processedDate: paymentData.processedDate?.toDate?.() || (paymentData.processedDate ? new Date(paymentData.processedDate) : undefined),
                refundDate: paymentData.refundDate?.toDate?.() || (paymentData.refundDate ? new Date(paymentData.refundDate) : undefined),
                createdAt: paymentData.createdAt?.toDate?.() || new Date(paymentData.createdAt),
                updatedAt: paymentData.updatedAt?.toDate?.() || new Date(paymentData.updatedAt),
              } as Payment);
            }
          }
        }
        
        setIsLoading(false);
      };

      fetchInvoice();
    }
  }, [id]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">Loading invoice...</div>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200">
        <p className="text-gray-500">Invoice not found.</p>
        <Link to="/client/invoices" className="text-blue-600 hover:underline mt-4 inline-block">
          ← Back to Invoices
        </Link>
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

  const isOverdue = invoice.status === 'pending' && new Date() > invoice.dueDate;

  return (
    <div>
      <div className="mb-6">
        <Link to="/client/invoices" className="text-blue-600 hover:underline mb-4 inline-block">
          ← Back to Invoices
        </Link>
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold mb-2">
              Invoice {invoice.invoiceNumber}
            </h1>
            <p className="text-gray-600">{getSubscriptionLabel(invoice)} Subscription</p>
          </div>
          <span className={`px-4 py-2 rounded-full text-sm font-medium ${getStatusColor(invoice.status)}`}>
            {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
            {isOverdue && ' (Overdue)'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Invoice Details */}
        <div className="lg:col-span-2 space-y-6">
          {/* Invoice Information */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">Invoice Details</h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-500">Issue Date</p>
                <p className="font-medium">{format(invoice.issueDate, 'MMMM dd, yyyy')}</p>
              </div>
              <div>
                <p className="text-gray-500">Due Date</p>
                <p className={`font-medium ${isOverdue ? 'text-red-600' : ''}`}>
                  {format(invoice.dueDate, 'MMMM dd, yyyy')}
                </p>
              </div>
              {invoice.periodStart && invoice.periodEnd && (
                <>
                  <div>
                    <p className="text-gray-500">Period Start</p>
                    <p className="font-medium">{format(invoice.periodStart, 'MMMM dd, yyyy')}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Period End</p>
                    <p className="font-medium">{format(invoice.periodEnd, 'MMMM dd, yyyy')}</p>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Line Items */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">Line Items</h2>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-4 font-medium">Description</th>
                    <th className="text-right py-2 px-4 font-medium">Quantity</th>
                    <th className="text-right py-2 px-4 font-medium">Unit Price</th>
                    <th className="text-right py-2 px-4 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lineItems.map((item, index) => (
                    <tr key={index} className="border-b">
                      <td className="py-2 px-4">{item.description}</td>
                      <td className="text-right py-2 px-4">{item.quantity}</td>
                      <td className="text-right py-2 px-4">€{item.unitPrice.toFixed(2)}</td>
                      <td className="text-right py-2 px-4 font-medium">€{item.total.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2">
                    <td colSpan={3} className="text-right py-2 px-4 font-medium">Subtotal</td>
                    <td className="text-right py-2 px-4 font-medium">€{invoice.subtotal.toFixed(2)}</td>
                  </tr>
                  {invoice.tax && invoice.taxRate && (
                    <tr>
                      <td colSpan={3} className="text-right py-2 px-4">Tax ({invoice.taxRate * 100}%)</td>
                      <td className="text-right py-2 px-4">€{invoice.tax.toFixed(2)}</td>
                    </tr>
                  )}
                  <tr className="border-t-2 font-bold text-lg">
                    <td colSpan={3} className="text-right py-2 px-4">Total</td>
                    <td className="text-right py-2 px-4">€{invoice.total.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Notes */}
          {invoice.notes && (
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
              <h2 className="text-lg font-semibold mb-2">Notes</h2>
              <p className="text-gray-600">{invoice.notes}</p>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Billing Information */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">Billing Information</h2>
            <div className="space-y-2 text-sm">
              <div>
                <p className="text-gray-500">Name</p>
                <p className="font-medium">{invoice.billingName}</p>
              </div>
              <div>
                <p className="text-gray-500">Email</p>
                <p className="font-medium">{invoice.billingEmail}</p>
              </div>
              {invoice.billingPhone && (
                <div>
                  <p className="text-gray-500">Phone</p>
                  <p className="font-medium">{invoice.billingPhone}</p>
                </div>
              )}
            </div>
          </div>

          {/* Payment Information */}
          {payment && (
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
              <h2 className="text-lg font-semibold mb-4">Payment Information</h2>
              <div className="space-y-2 text-sm">
                <div>
                  <p className="text-gray-500">Status</p>
                  <p className={`font-medium ${
                    payment.status === 'completed' ? 'text-green-600' : 
                    payment.status === 'failed' ? 'text-red-600' : 
                    'text-yellow-600'
                  }`}>
                    {payment.status.charAt(0).toUpperCase() + payment.status.slice(1)}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Method</p>
                  <p className="font-medium">
                    {payment.method.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Amount</p>
                  <p className="font-medium">€{payment.amount.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Payment Date</p>
                  <p className="font-medium">{format(payment.paymentDate, 'MMMM dd, yyyy')}</p>
                </div>
                {payment.processedDate && (
                  <div>
                    <p className="text-gray-500">Processed Date</p>
                    <p className="font-medium">{format(payment.processedDate, 'MMMM dd, yyyy')}</p>
                  </div>
                )}
                {payment.transactionId && (
                  <div>
                    <p className="text-gray-500">Transaction ID</p>
                    <p className="font-medium text-xs">{payment.transactionId}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">Actions</h2>
            <div className="space-y-2">
              {invoice.status === 'pending' && (
                <button
                  className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors"
                  onClick={() => {
                    // TODO: Implement payment flow
                    alert('Payment integration coming soon!');
                  }}
                >
                  Pay Now
                </button>
              )}
              <button
                className="w-full bg-gray-100 text-gray-700 py-2 px-4 rounded-lg hover:bg-gray-200 transition-colors"
                onClick={() => {
                  // TODO: Implement download PDF
                  alert('Download PDF coming soon!');
                }}
              >
                Download PDF
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}












