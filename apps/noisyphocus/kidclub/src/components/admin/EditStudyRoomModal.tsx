import { useState, useEffect } from 'react';
import type { StudyRoomEntry } from "@shared/models/StudyRoomEntry";
import { StudyCenterConfig } from "@shared/models/StudyCenterConfig"; // Import StudyCenterConfig
import StudyRoomForm from "../StudyRoomForm"; // Import the main StudyRoomForm

interface EditStudyRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  entry: StudyRoomEntry | null;
  onSave: (updatedEntry: StudyRoomEntry, reason: string) => void;
  priceConfig: StudyCenterConfig; // Pass priceConfig to the modal
}

export default function EditStudyRoomModal({ isOpen, onClose, entry, onSave, priceConfig }: EditStudyRoomModalProps) {
  if (!isOpen || !entry) {
    return null;
  }

  const handleFormSave = (updatedEntry: StudyRoomEntry, reason: string) => {
    onSave(updatedEntry, reason);
    onClose(); // Close modal after saving
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold mb-4">Editar Inscrição</h2>
        <StudyRoomForm
          initialData={entry}
          onSave={handleFormSave}
          priceConfig={priceConfig}
        />
      </div>
    </div>
  );
}