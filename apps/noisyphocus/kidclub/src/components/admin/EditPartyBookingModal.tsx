import { Booking, PartyConfig } from "@shared/models";
import React from "react";
import PartyBookingForm from "../PartyBookingForm";

interface EditPartyBookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  booking: Booking | null;
  onSave: (updatedBooking: Booking, reason: string) => void;
  partyConfig: PartyConfig;
}

export default function EditPartyBookingModal({
  isOpen,
  onClose,
  booking,
  onSave,
  partyConfig,
}: EditPartyBookingModalProps) {

  if (!isOpen || !booking) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        <div className="p-6 overflow-y-auto">
          <PartyBookingForm
            initialData={booking}
            onSave={onSave}
            partyConfig={partyConfig}
          />
        </div>
        <div className="flex justify-end space-x-2 p-4 bg-gray-50 rounded-b-lg mt-auto">
          <button onClick={onClose} className="px-4 py-2 bg-gray-300 text-black rounded-md hover:bg-gray-400">Close</button>
        </div>
      </div>
    </div>
  );
}