import { useState } from 'react';

interface ReasonPromptModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  reasonRequired?: boolean;
}

export default function ReasonPromptModal({ isOpen, title, message, onConfirm, onCancel, reasonRequired = true }: ReasonPromptModalProps) {
  const [reason, setReason] = useState('');

  if (!isOpen) {
    return null;
  }

  const handleConfirm = () => {
    if (!reasonRequired || reason.trim()) {
      onConfirm(reason || 'N/A');
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 shadow-xl w-full max-w-md">
        <h2 className="text-xl font-bold mb-4">{title}</h2>
        <p className="mb-4">{message}</p>
        <textarea
          className="w-full border rounded px-3 py-2"
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Insira a razão..."
        />
        <div className="flex justify-end gap-4 mt-4">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded bg-gray-200 hover:bg-gray-300"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={reasonRequired && !reason.trim()}
            className="px-4 py-2 rounded bg-pink-500 text-white hover:bg-pink-600 disabled:bg-pink-300"
          >
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
}