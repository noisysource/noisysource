import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getDoc, query, where, getDocs } from 'firebase/firestore';
import { col, docRef } from '../../lib/db';
import { Invoice, Payment } from '@shared/models';
import { format } from 'date-fns';

const STATUS_PT: Record<string, string> = {
  paid: 'Paga', pending: 'Pendente', overdue: 'Em atraso',
  cancelled: 'Cancelada', canceled: 'Cancelada',
};

const STATUS_CLS: Record<string, string> = {
  paid: 'bg-green-100 text-green-800',
  pending: 'bg-yellow-100 text-yellow-800',
  overdue: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-800',
};

const PAYMENT_STATUS_PT: Record<string, string> = {
  completed: 'Concluído', failed: 'Falhado', pending: 'Pendente', refunded: 'Reembolsado',
};

const PAYMENT_METHOD_PT: Record<string, string> = {
  bank_transfer: 'Transferência bancária', mbway: 'MB Way', cash: 'Numerário',
  card: 'Cartão', multibanco: 'Multibanco',
};

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (id) {
      const fetchInvoice = async () => {
        setIsLoading(true);

        const invoiceRef = docRef('invoices', id);
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

          if (invoiceData.paymentId) {
            const paymentRef = docRef('payments', invoiceData.paymentId);
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
            const paymentsQuery = query(col('payments'), where('invoiceId', '==', invoiceSnap.id));
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
        <div className="text-gray-500">A carregar...</div>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200">
        <p className="text-gray-500">Fatura não encontrada.</p>
        <Link to="/client/invoices" className="text-blue-600 hover:underline mt-4 inline-block">
          ← Faturas
        </Link>
      </div>
    );
  }

  const getSubscriptionLabel = (inv: Invoice) => {
    const types = inv.subscriptionItems?.map(i => i.subscriptionType) ?? [];
    if (types.includes('study') && types.includes('transport')) return 'Sala de Estudo & Transporte';
    if (types.includes('study')) return 'Sala de Estudo';
    if (types.includes('transport')) return 'Transporte Escolar';
    return 'Serviços';
  };

  const isOverdue = invoice.status === 'pending' && new Date() > invoice.dueDate;

  return (
    <div>
      <div className="mb-6">
        <Link to="/client/invoices" className="text-blue-600 hover:underline mb-4 inline-block">
          ← Faturas
        </Link>
        <div className="flex justify-between items-start flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold mb-1">
              Fatura {invoice.invoiceNumber}
            </h1>
            <p className="text-gray-600">{getSubscriptionLabel(invoice)}</p>
          </div>
          <span className={`px-4 py-2 rounded-full text-sm font-medium ${STATUS_CLS[invoice.status] ?? 'bg-gray-100 text-gray-800'}`}>
            {STATUS_PT[invoice.status] ?? invoice.status}
            {isOverdue && ' (Em atraso)'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main details */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">Detalhes da fatura</h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-500">Data de emissão</p>
                <p className="font-medium">{format(invoice.issueDate, 'dd/MM/yyyy')}</p>
              </div>
              <div>
                <p className="text-gray-500">Data de vencimento</p>
                <p className={`font-medium ${isOverdue ? 'text-red-600' : ''}`}>
                  {format(invoice.dueDate, 'dd/MM/yyyy')}
                </p>
              </div>
              {invoice.periodStart && invoice.periodEnd && (
                <>
                  <div>
                    <p className="text-gray-500">Início do período</p>
                    <p className="font-medium">{format(invoice.periodStart, 'dd/MM/yyyy')}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Fim do período</p>
                    <p className="font-medium">{format(invoice.periodEnd, 'dd/MM/yyyy')}</p>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Line items */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">Serviços</h2>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-4 font-medium">Descrição</th>
                    <th className="text-right py-2 px-4 font-medium">Qtd</th>
                    <th className="text-right py-2 px-4 font-medium">Preço unit.</th>
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
                      <td colSpan={3} className="text-right py-2 px-4">IVA ({invoice.taxRate * 100}%)</td>
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

          {invoice.notes && (
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
              <h2 className="text-lg font-semibold mb-2">Notas</h2>
              <p className="text-gray-600">{invoice.notes}</p>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">Dados de faturação</h2>
            <div className="space-y-2 text-sm">
              <div>
                <p className="text-gray-500">Nome</p>
                <p className="font-medium">{invoice.billingName}</p>
              </div>
              <div>
                <p className="text-gray-500">Email</p>
                <p className="font-medium">{invoice.billingEmail}</p>
              </div>
              {invoice.billingPhone && (
                <div>
                  <p className="text-gray-500">Telefone</p>
                  <p className="font-medium">{invoice.billingPhone}</p>
                </div>
              )}
            </div>
          </div>

          {payment && (
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
              <h2 className="text-lg font-semibold mb-4">Pagamento</h2>
              <div className="space-y-2 text-sm">
                <div>
                  <p className="text-gray-500">Estado</p>
                  <p className={`font-medium ${
                    payment.status === 'completed' ? 'text-green-600' :
                    payment.status === 'failed' ? 'text-red-600' :
                    'text-yellow-600'
                  }`}>
                    {PAYMENT_STATUS_PT[payment.status] ?? payment.status}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Método</p>
                  <p className="font-medium">
                    {PAYMENT_METHOD_PT[payment.method] ?? payment.method}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Valor</p>
                  <p className="font-medium">€{payment.amount.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Data de pagamento</p>
                  <p className="font-medium">{format(payment.paymentDate, 'dd/MM/yyyy')}</p>
                </div>
                {payment.processedDate && (
                  <div>
                    <p className="text-gray-500">Data de processamento</p>
                    <p className="font-medium">{format(payment.processedDate, 'dd/MM/yyyy')}</p>
                  </div>
                )}
                {payment.transactionId && (
                  <div>
                    <p className="text-gray-500">Referência</p>
                    <p className="font-medium text-xs">{payment.transactionId}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">Ações</h2>
            <div className="space-y-2">
              {invoice.status === 'pending' && (
                <Link
                  to="/client/payments"
                  className="block w-full text-center bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Pagar agora
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
