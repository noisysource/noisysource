import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { db } from '../../lib/firebase';
import { collection, getDocs, query, where, doc, getDoc } from 'firebase/firestore';
import { Payment, Invoice } from '@shared/models';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';

export default function PaymentHistoryPage() {
  const user = useUser();
  const [payments, setPayments] = useState<(Payment & { invoice?: Invoice })[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (user) {
      const fetchPayments = async () => {
        setIsLoading(true);
        
        // Fetch payments
        const paymentsQuery = query(
          collection(db, 'payments'),
          where('userId', '==', user.uid),
        );
        const paymentsSnap = await getDocs(paymentsQuery);
        
        // Fetch associated invoices
        const paymentsWithInvoices = await Promise.all(
          paymentsSnap.docs.map(async (docSnap) => {
            const paymentData = docSnap.data();
            const payment = {
              ...paymentData,
              id: docSnap.id,
              paymentDate: paymentData.paymentDate?.toDate?.() || new Date(paymentData.paymentDate),
              processedDate: paymentData.processedDate?.toDate?.() || (paymentData.processedDate ? new Date(paymentData.processedDate) : undefined),
              refundDate: paymentData.refundDate?.toDate?.() || (paymentData.refundDate ? new Date(paymentData.refundDate) : undefined),
              createdAt: paymentData.createdAt?.toDate?.() || new Date(paymentData.createdAt),
              updatedAt: paymentData.updatedAt?.toDate?.() || new Date(paymentData.updatedAt),
            } as Payment;

            // Fetch invoice
            let invoice: Invoice | undefined;
            if (payment.invoiceId) {
              try {
                const invoiceRef = doc(db, 'invoices', payment.invoiceId);
                const invoiceSnap = await getDoc(invoiceRef);
                if (invoiceSnap.exists()) {
                  const invoiceData = invoiceSnap.data();
                  invoice = {
                    ...invoiceData,
                    id: invoiceSnap.id,
                    issueDate: invoiceData.issueDate?.toDate?.() || new Date(invoiceData.issueDate),
                    dueDate: invoiceData.dueDate?.toDate?.() || new Date(invoiceData.dueDate),
                    paidDate: invoiceData.paidDate?.toDate?.() || (invoiceData.paidDate ? new Date(invoiceData.paidDate) : undefined),
                    periodStart: invoiceData.periodStart?.toDate?.() || (invoiceData.periodStart ? new Date(invoiceData.periodStart) : undefined),
                    periodEnd: invoiceData.periodEnd?.toDate?.() || (invoiceData.periodEnd ? new Date(invoiceData.periodEnd) : undefined),
                    createdAt: invoiceData.createdAt?.toDate?.() || new Date(invoiceData.createdAt),
                    updatedAt: invoiceData.updatedAt?.toDate?.() || new Date(invoiceData.updatedAt),
                  } as Invoice;
                }
              } catch (error) {
                console.error('Error fetching invoice:', error);
              }
            }

            return { ...payment, invoice };
          })
        );
        
        paymentsWithInvoices.sort((a, b) => b.paymentDate.getTime() - a.paymentDate.getTime());
        setPayments(paymentsWithInvoices);
        setIsLoading(false);
      };

      fetchPayments();
    }
  }, [user]);

  const getStatusColor = (status: Payment['status']) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'refunded':
        return 'bg-yellow-100 text-yellow-800';
      case 'pending':
      case 'processing':
        return 'bg-blue-100 text-blue-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getMethodLabel = (method: Payment['method']) => {
    return method.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">Loading payment history...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Payment History</h1>
        <p className="text-gray-600 mt-2">View all your payment transactions</p>
      </div>

      {payments.length > 0 ? (
        <div className="space-y-4">
          {payments.map((payment) => (
            <div
              key={payment.id}
              className="bg-white p-6 rounded-lg shadow-sm border border-gray-200"
            >
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-semibold">
                      Payment #{payment.id.slice(-8).toUpperCase()}
                    </h3>
                    <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(payment.status)}`}>
                      {payment.status.charAt(0).toUpperCase() + payment.status.slice(1)}
                    </span>
                  </div>
                  
                  {payment.invoice && (
                    <Link
                      to={`/client/invoices/${payment.invoice.id}`}
                      className="text-blue-600 hover:underline mb-2 inline-block"
                    >
                      Invoice {payment.invoice.invoiceNumber}
                    </Link>
                  )}
                  
                  <div className="flex gap-4 text-sm text-gray-500 mt-2">
                    <span>
                      <strong>Method:</strong> {getMethodLabel(payment.method)}
                    </span>
                    <span>
                      <strong>Date:</strong> {format(payment.paymentDate, 'MMM dd, yyyy')}
                    </span>
                    {payment.processedDate && (
                      <span>
                        <strong>Processed:</strong> {format(payment.processedDate, 'MMM dd, yyyy')}
                      </span>
                    )}
                  </div>
                  
                  {payment.paymentMethodDetails && (
                    <div className="mt-2 text-sm text-gray-600">
                      {payment.paymentMethodDetails.last4 && (
                        <span>Card ending in {payment.paymentMethodDetails.last4}</span>
                      )}
                      {payment.paymentMethodDetails.reference && (
                        <span className="ml-4">Reference: {payment.paymentMethodDetails.reference}</span>
                      )}
                    </div>
                  )}
                  
                  {payment.refundAmount && payment.refundDate && (
                    <div className="mt-2 text-sm text-red-600">
                      Refunded €{payment.refundAmount.toFixed(2)} on {format(payment.refundDate, 'MMM dd, yyyy')}
                      {payment.refundReason && ` - ${payment.refundReason}`}
                    </div>
                  )}
                  
                  {payment.notes && (
                    <div className="mt-2 text-sm text-gray-600">
                      <strong>Notes:</strong> {payment.notes}
                    </div>
                  )}
                </div>
                
                <div className="text-right">
                  <div className="text-2xl font-bold text-gray-900">
                    {payment.refundAmount ? (
                      <>
                        <span className="line-through text-gray-400">
                          €{payment.amount.toFixed(2)}
                        </span>
                        <br />
                        <span className="text-red-600">
                          -€{payment.refundAmount.toFixed(2)}
                        </span>
                      </>
                    ) : (
                      <>€{payment.amount.toFixed(2)}</>
                    )}
                  </div>
                  <div className="text-sm text-gray-500 mt-1">
                    {payment.currency}
                  </div>
                  {payment.transactionId && (
                    <div className="text-xs text-gray-400 mt-2">
                      TX: {payment.transactionId.slice(0, 8)}...
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
          <p className="text-gray-500">You have no payment history yet.</p>
        </div>
      )}
    </div>
  );
}












