import { useCallback, useEffect, useMemo, useState } from 'react';
import { Booking, PartyConfig, partyVatBreakdown } from '@shared/models';
import { partyService } from '../../services/partyService';
import PartyBookingCard from './PartyBookingCard';
import EditPartyBookingModal from './EditPartyBookingModal';
import { useUser } from '@shared/hooks';

type Status = "pending" | "confirmed" | "rejected";

const statusBadge = (status: Status) => {
  switch (status) {
    case "pending":
      return "bg-yellow-100 text-yellow-800 border-yellow-200";
    case "confirmed":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "rejected":
      return "bg-gray-100 text-gray-800 border-gray-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200";
  }
};

const statusLabel = (status: Status) => {
  switch (status) {
    case "pending":
      return "Pendente";
    case "confirmed":
      return "Confirmada";
    case "rejected":
      return "Rejeitada";
    default:
      return "Desconhecido";
  }
};

export default function PartyAdminPanel() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [activeTab, setActiveTab] = useState<Status>("pending");
  const [bookingToEdit, setBookingToEdit] = useState<Booking | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [partyConfig, setPartyConfig] = useState<PartyConfig | null>(null);
  const [showAll, setShowAll] = useState(false);
  const user = useUser();

  const currencyFormatter = useMemo(
    () => new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }),
    []
  );

  const getBookingDateTime = useCallback((booking: Booking) => {
    if (!booking?.date) {
      return new Date(0);
    }

    const date = new Date(booking.date);
    if (!Number.isNaN(date.getTime())) {
      const [hours, minutes] = (booking.time || '00:00').split(':');
      date.setHours(Number(hours) || 0, Number(minutes) || 0, 0, 0);
      return date;
    }

    return new Date(0);
  }, []);

  const sortBookings = useCallback(
    (list: Booking[]) =>
      [...list].sort(
        (a, b) => getBookingDateTime(a).getTime() - getBookingDateTime(b).getTime()
      ),
    [getBookingDateTime]
  );

  const isUpcoming = useCallback(
    (booking: Booking) => {
      const bookingDate = getBookingDateTime(booking);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return bookingDate.getTime() >= today.getTime();
    },
    [getBookingDateTime]
  );

  useEffect(() => {
    const fetchData = async () => {
      const list = await partyService.getBookings();
      setBookings(sortBookings(list));
    };
    fetchData();
  }, [sortBookings]);

  useEffect(() => {
    const fetchPartyConfig = async () => {
      const data = await partyService.getPartyConfig();
      setPartyConfig(data);
    };
    fetchPartyConfig();
  }, []);

  // Confirming now has effects outside the app (onPartyBookingStatusNotify):
  // the deposit bill and an email to the parent. Rejecting emails the reason.
  const handleStatusChange = async (id: string, newStatus: Booking['status']) => {
    const booking = bookings.find(b => b.id === id);
    if (!booking) return;

    const header = `${booking.partyType || 'Festa'} · ${booking.childName} · ${booking.date}${booking.time ? ` ${booking.time}` : ''}\n`;
    let reason: string | undefined;
    if (newStatus === 'confirmed') {
      const deposit = partyVatBreakdown(booking.total).deposit;
      const ok = window.confirm(`${header}Confirmar esta reserva?\n\n`
        + `• O sinal de 50% (${currencyFormatter.format(deposit)}, IVA incluído) é lançado nos pagamentos da família\n`
        + `• ${booking.email || 'O encarregado'} recebe um email com a confirmação e o link para pagar`);
      if (!ok) return;
    } else if (newStatus === 'rejected') {
      const answer = window.prompt(`${header}Rejeitar esta reserva?\n\n`
        + `${booking.email || 'O encarregado'} recebe um email com o motivo.\n\nMotivo (opcional):`, booking.statusReason ?? '');
      if (answer === null) return;
      reason = answer.trim() || undefined;
    }

    try {
      await partyService.updateBookingStatus(id, newStatus, reason);
    } catch (err) {
      console.error('[PartyAdmin] status change failed:', err);
      alert('Não foi possível alterar o estado da reserva.');
      return;
    }

    setBookings((prev) =>
      sortBookings(
        prev.map((b) => (b.id === id ? { ...b, status: newStatus as Booking['status'], ...(reason ? { statusReason: reason } : {}) } : b))
      )
    );
  };

  const visibleBookings = useMemo(
    () => (showAll ? bookings : bookings.filter(isUpcoming)),
    [bookings, isUpcoming, showAll]
  );

  const pending = useMemo(
    () => visibleBookings.filter((b) => b.status === 'pending'),
    [visibleBookings]
  );

  const confirmed = useMemo(
    () => visibleBookings.filter((b) => b.status === 'confirmed'),
    [visibleBookings]
  );

  const rejected = useMemo(
    () => visibleBookings.filter((b) => b.status === 'rejected'),
    [visibleBookings]
  );

  const summary = useMemo(() => {
    const upcomingBookings = bookings.filter(isUpcoming);
    const upcomingConfirmed = upcomingBookings.filter((b) => b.status === 'confirmed');
    const upcomingPending = upcomingBookings.filter((b) => b.status === 'pending');
    const upcomingRevenue = upcomingConfirmed.reduce((sum, booking) => sum + (booking.total || 0), 0);

    return {
      totalUpcoming: upcomingBookings.length,
      totalPast: bookings.length - upcomingBookings.length,
      pendingUpcoming: upcomingPending.length,
      confirmedUpcoming: upcomingConfirmed.length,
      upcomingRevenue,
    };
  }, [bookings, isUpcoming]);

  const handleEditBooking = (booking: Booking) => {
    setBookingToEdit(booking);
    setShowEditModal(true);
  };

  const handleSaveBooking = async (updatedBooking: Booking, reason: string) => {
    if (!bookingToEdit) return;

    await partyService.updateBooking(updatedBooking);

    setBookings((prev) =>
      sortBookings(
        prev.map((booking) =>
          booking.id === updatedBooking.id
            ? { ...booking, ...updatedBooking }
            : booking
        )
      )
    );

    setShowEditModal(false);
    setBookingToEdit(null);
  };

  const renderBookings = (filteredBookings: Booking[]) => (
    filteredBookings.length === 0 ? (
      <p className="text-center text-gray-600">Nenhuma reserva encontrada.</p>
    ) : (
      <ul className="space-y-4">
        {filteredBookings.map((b) => (
          <PartyBookingCard
            key={b.id}
            booking={b}
            statusBadge={statusBadge}
            statusLabel={statusLabel}
            confirmBooking={(id) => handleStatusChange(id, 'confirmed')}
            rejectBooking={(id) => handleStatusChange(id, 'rejected')}
            onFileUpload={() => {}}
            onEditBooking={handleEditBooking}
            currentUser={user}
          />
        ))}
      </ul>
    )
  );

  return (
    <div className="p-6 max-w-6xl mx-auto font-[Fredoka] bg-gray-50 min-h-screen">
      <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between mb-8 gap-4">
        <h1 className="text-3xl font-bold text-gray-900">🎈 Gestão de Festas</h1>
        <div className="flex items-center">
          <input
            type="checkbox"
            id="showAll"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="h-4 w-4 text-pink-600 border-gray-300 rounded focus:ring-pink-500"
          />
          <label htmlFor="showAll" className="ml-2 block text-sm text-gray-900">
            Mostrar todas as reservas
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Próximas festas</p>
          <p className="text-2xl font-semibold text-gray-900">{summary.totalUpcoming}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Pendentes (próximas)</p>
          <p className="text-2xl font-semibold text-amber-600">{summary.pendingUpcoming}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Confirmadas (próximas)</p>
          <p className="text-2xl font-semibold text-emerald-600">{summary.confirmedUpcoming}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <p className="text-sm text-gray-500">Receita estimada</p>
          <p className="text-2xl font-semibold text-indigo-600">{currencyFormatter.format(summary.upcomingRevenue)}</p>
          <p className="text-xs text-gray-400 mt-1">Confirmadas e futuras, sem IVA</p>
        </div>
      </div>

      {!showAll && (
        <div className="mb-4 text-sm text-gray-600 bg-blue-50 border border-blue-100 rounded-lg px-4 py-2">
          A mostrar apenas festas futuras. Seleciona "Mostrar todas" para incluir eventos passados ({summary.totalPast}).
        </div>
      )}

      <div className="mb-6 border-b border-gray-200">
        <ul className="flex flex-wrap -mb-px text-base font-medium text-center" role="tablist"> 
          <li className="me-2" role="presentation">
            <button
              className={`inline-block p-4 border-b-2 rounded-t-lg transition-colors duration-200 w-36 ${activeTab === "pending" ? "text-blue-600 border-blue-600" : "text-gray-500 hover:text-gray-700 hover:border-gray-300"}`}
              onClick={() => setActiveTab("pending")}
              type="button"
              role="tab"
              aria-selected={activeTab === "pending"}
            >
              Pendentes ({pending.length})
            </button>
          </li>
          <li className="me-2" role="presentation">
            <button
              className={`inline-block p-4 border-b-2 rounded-t-lg transition-colors duration-200 w-36 ${activeTab === "confirmed" ? "text-blue-600 border-blue-600" : "text-gray-500 hover:text-gray-700 hover:border-gray-300"}`}
              onClick={() => setActiveTab("confirmed")}
              type="button"
              role="tab"
              aria-selected={activeTab === "confirmed"}
            >
              Confirmadas ({confirmed.length})
            </button>
          </li>
          <li className="me-2" role="presentation">
            <button
              className="inline-block p-4 border-b-2 rounded-t-lg transition-colors duration-200 w-36 text-gray-500 hover:text-gray-700 hover:border-gray-300"
              onClick={() => setActiveTab("rejected")}
              type="button"
              role="tab"
              aria-selected={activeTab === "rejected"}
            >
              Rejeitadas ({rejected.length})
            </button>
          </li>
        </ul>
      </div>

      <div>
        {activeTab === "pending" && renderBookings(pending)}
        {activeTab === "confirmed" && renderBookings(confirmed)}
        {activeTab === "rejected" && renderBookings(rejected)}
      </div>

      {partyConfig && <EditPartyBookingModal
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        booking={bookingToEdit}
        onSave={handleSaveBooking}
        partyConfig={partyConfig}
      />}
    </div>
  );
}
