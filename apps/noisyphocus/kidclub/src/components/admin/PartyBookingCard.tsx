import { Booking, extraQty, partyVatBreakdown } from "@shared/models";
import { AppUser } from "@shared/models/AppUser";
import React, { useState } from "react";

interface PartyBookingCardProps {
  booking: Booking;
  statusBadge: (status: any) => string;
  statusLabel: (status: any) => string;
  confirmBooking: (id: string) => void;
  rejectBooking: (id: string) => void;
  onFileUpload: (bookingId: string, file: File) => void;
  onEditBooking: (booking: Booking) => void;
  currentUser: AppUser | null | undefined;
}

export default function PartyBookingCard({
  booking,
  statusBadge,
  statusLabel,
  confirmBooking,
  rejectBooking,
  onFileUpload,
  onEditBooking,
  currentUser,
}: PartyBookingCardProps) {
  const [activeCardTab, setActiveCardTab] = useState<'details' | 'customer' | 'extras' | 'documents'>('details');

  return (
    <li className="bg-white shadow-lg rounded-xl overflow-hidden transition-transform transform hover:-translate-y-1">
      <div className={`px-6 py-4 border-l-8 ${statusBadge(booking.status)}`}>
        <div className="flex justify-between items-center">
          <h3 className="text-xl font-bold text-gray-800">{booking.childName}</h3>
          <span className={`px-3 py-1 text-sm font-semibold rounded-full ${statusBadge(booking.status)}`}>
            {statusLabel(booking.status)}
          </span>
        </div>
        <p className="text-gray-600 text-sm">{booking.partyType}</p>
      </div>
      <div className="px-6 py-4">
        <div className="mb-4 border-b border-gray-200">
          <ul className="flex flex-wrap -mb-px text-sm font-medium text-center" role="tablist">
            <li className="me-2" role="presentation">
              <button
                className={`inline-block p-2 border-b-2 rounded-t-lg ${activeCardTab === "details" ? "text-blue-600 border-blue-600" : "hover:text-gray-600 hover:border-gray-300"}`}
                onClick={() => setActiveCardTab("details")}
                type="button"
                role="tab"
                aria-selected={activeCardTab === "details"}
              >
                Detalhes
              </button>
            </li>
            <li className="me-2" role="presentation">
              <button
                className={`inline-block p-2 border-b-2 rounded-t-lg ${activeCardTab === "customer" ? "text-blue-600 border-blue-600" : "hover:text-gray-600 hover:border-gray-300"}`}
                onClick={() => setActiveCardTab("customer")}
                type="button"
                role="tab"
                aria-selected={activeCardTab === "customer"}
              >
                Cliente
              </button>
            </li>
            <li className="me-2" role="presentation">
              <button
                className={`inline-block p-2 border-b-2 rounded-t-lg ${activeCardTab === "extras" ? "text-blue-600 border-blue-600" : "hover:text-gray-600 hover:border-gray-300"}`}
                onClick={() => setActiveCardTab("extras")}
                type="button"
                role="tab"
                aria-selected={activeCardTab === "extras"}
              >
                Extras
              </button>
            </li>
            <li className="me-2" role="presentation">
              <button
                className={`inline-block p-2 border-b-2 rounded-t-lg ${activeCardTab === "documents" ? "text-blue-600 border-blue-600" : "hover:text-gray-600 hover:border-gray-300"}`}
                onClick={() => setActiveCardTab("documents")}
                type="button"
                role="tab"
                aria-selected={activeCardTab === "documents"}
              >
                Documentos
              </button>
            </li>
          </ul>
        </div>

        <div>
          {activeCardTab === "details" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <p><strong>Data:</strong> {booking.date} às {booking.time}</p>
                <p><strong>Nº de Crianças:</strong> {booking.numKids}</p>
                <p><strong>Tema:</strong> {(booking as any).theme}</p>
              </div>
              <div>
                <p><strong>Total:</strong> €{partyVatBreakdown(booking.total).total.toFixed(2)} <span className="text-gray-500">(€{partyVatBreakdown(booking.total).subtotal.toFixed(2)} + IVA)</span></p>
              </div>
            </div>
          )}
          {activeCardTab === "customer" && (
            <div className="text-sm">
              <p><strong>Responsável:</strong> {booking.parentName}</p>
              <p><strong>Email:</strong> {booking.email}</p>
              <p><strong>Telemóvel:</strong> {booking.phone}</p>
            </div>
          )}
          {activeCardTab === "extras" && (
            <div className="text-sm">
              {booking.extras && booking.extras.length > 0 ? (
                <ul className="list-disc list-inside">
                  {booking.extras.map((extra) => (
                    <li key={extra}>{extraQty(booking, extra) > 1 ? `${extraQty(booking, extra)} × ${extra}` : extra}</li>
                  ))}
                </ul>
              ) : (
                <p>Nenhum extra selecionado.</p>
              )}
            </div>
          )}
          {activeCardTab === "documents" && (
            <div>
              <p>Documentos</p>
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end space-x-2">
          {booking.status === "pending" && (
            <>
              <button onClick={() => confirmBooking(booking.id)} className="px-3 py-1 bg-green-500 text-white rounded-md hover:bg-green-600">Confirmar</button>
              <button onClick={() => rejectBooking(booking.id)} className="px-3 py-1 bg-red-500 text-white rounded-md hover:bg-red-600">Rejeitar</button>
            </>
          )}
          <button onClick={() => onEditBooking(booking)} className="px-3 py-1 bg-blue-500 text-white rounded-md hover:bg-blue-600">Editar</button>
        </div>
      </div>
    </li>
  );
}
