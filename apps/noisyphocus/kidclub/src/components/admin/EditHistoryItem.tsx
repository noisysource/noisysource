import { useState } from "react";
import { format } from "date-fns";
import { Timestamp } from "firebase/firestore";
import type { EntryChangeHistory, StudyStatus } from "@shared/models/StudyRoomEntry";

interface EditHistoryItemProps {
  editEntry: EntryChangeHistory;
  statusLabel: (status: StudyStatus) => string;
  formatValue: (field: string, value: any) => string;
}

export default function EditHistoryItem({
  editEntry,
  statusLabel,
  formatValue,
}: EditHistoryItemProps) {
  const [isEditExpanded, setIsEditExpanded] = useState(false);

  return (
    <li className="bg-gray-50 p-3 rounded-md border border-gray-200">
      <button
        onClick={() => setIsEditExpanded(!isEditExpanded)}
        className="w-full text-left font-medium text-gray-800 flex justify-between items-center"
      >
        <span>
          Edição em {editEntry.timestamp instanceof Timestamp ? format(editEntry.timestamp.toDate(), "dd/MM/yyyy HH:mm") : "—"}
        </span>
        <span>{isEditExpanded ? '▲' : '▼'}</span>
      </button>
      {isEditExpanded && (
        <div className="mt-2 text-sm text-gray-700 space-y-1">
          <p><strong>Campo:</strong> {editEntry.field}</p>
          <p><strong>De:</strong> {formatValue(editEntry.field, editEntry.oldValue)}</p>
          <p><strong>Para:</strong> {formatValue(editEntry.field, editEntry.newValue)}</p>
          <p><strong>Razão:</strong> {editEntry.reason}</p>
        </div>
      )}
    </li>
  );
}