import { useEffect, useMemo, useState } from "react";
import { Timestamp } from "firebase/firestore";
import { format } from "date-fns";
import type { StudyRoomEntry, EntryChangeHistory } from "@shared/models/StudyRoomEntry";
import { StudyCenterConfig } from "@shared/models/StudyCenterConfig";
import ReasonPromptModal from "../ReasonPromptModal";
import { useUser } from "@shared/hooks";
import StudyRoomEntryCard from "./StudyRoomEntryCard"; // Import the new component
import EditStudyRoomModal from "./EditStudyRoomModal"; // Import the new edit modal
import { studyRoomService } from "../../services/studyRoomService";

type Status = "pending" | "confirmed" | "canceled" | "archived";

const statusBadge = (status: Status) => {
  switch (status) {
    case "pending":
      return "bg-yellow-100 text-yellow-800 border-yellow-200";
    case "confirmed":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "canceled":
      return "bg-gray-100 text-gray-800 border-gray-200";
    case "archived":
      return "bg-blue-100 text-blue-800 border-blue-200";
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
    case "canceled":
      return "Cancelada";
    case "archived":
      return "Arquivada";
    default:
      return "Desconhecido";
  }
};

export default function StudyRoomAdminPanel() {
  const [entries, setEntries] = useState<StudyRoomEntry[]>([]);
  const [config, setConfig] = useState<StudyCenterConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Status>("pending");
  const user = useUser();

  // State for the reason prompt modal
  const [showReasonModal, setShowReasonModal] = useState(false);
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);
  const [currentStatusAction, setCurrentStatusAction] = useState<Status | null>(null);

  // State for the edit modal
  const [showEditModal, setShowEditModal] = useState(false);
  const [entryToEdit, setEntryToEdit] = useState<StudyRoomEntry | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [entries, config] = await Promise.all([
          studyRoomService.getStudyRoomEntries(),
          studyRoomService.getStudyCenterConfig(),
        ]);
        setEntries(entries);
        setConfig(config);
      } catch (e: any) {
        setErr(e?.message ?? "Falha a carregar inscrições");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const setStatus = async (id: string, status: Status, reason?: string) => {
    await studyRoomService.updateStudyRoomEntryStatus(id, status, reason);

    setEntries((prev) =>
      prev.map((e) =>
        e.id === id
          ? { ...e, status, statusReason: reason, statusHistory: [...(e.statusHistory || []), { status, reason, timestamp: Timestamp.now() }] }
          : e
      )
    );
  };

  const confirmEntry = (id: string) => {
    setCurrentEntryId(id);
    setCurrentStatusAction("confirmed");
    setShowReasonModal(true);
  };

  const cancelEntry = (id: string) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    setCurrentEntryId(id);
    setCurrentStatusAction("canceled");
    setShowReasonModal(true);
  };

  const archiveEntry = (id: string) => {
    setCurrentEntryId(id);
    setCurrentStatusAction("archived");
    setShowReasonModal(true);
  };

  const activateEntry = (id: string) => {
    setCurrentEntryId(id);
    setCurrentStatusAction("confirmed"); // Default to confirmed when activating
    setShowReasonModal(true);
  };

  const handleReasonSubmit = async (reason: string) => {
    if (currentEntryId && currentStatusAction) {
      await setStatus(currentEntryId, currentStatusAction, reason);
    }
    setShowReasonModal(false);
    setCurrentEntryId(null);
    setCurrentStatusAction(null);
  };

  const handleReasonCancel = () => {
    setShowReasonModal(false);
    setCurrentEntryId(null);
    setCurrentStatusAction(null);
  };

  const handleFileUpload = async (entryId: string, file: File) => {
    try {
      const newFile = await studyRoomService.uploadFile(entryId, file);
      // Update local state
      setEntries((prevEntries) =>
        prevEntries.map((entry) =>
          entry.id === entryId
            ? { ...entry, uploadedFiles: [...(entry.uploadedFiles || []), newFile] }
            : entry
        )
      );
    } catch (error) {
      console.error("Error uploading file:", error);
      throw error; // Re-throw to be caught by the card component
    }
  };

  const handleEditEntry = (entry: StudyRoomEntry) => {
    setEntryToEdit(entry);
    setShowEditModal(true);
  };

  const handleSaveEntry = async (updatedEntry: StudyRoomEntry, reason: string) => {
    if (!entryToEdit) return;

    const changes: EntryChangeHistory[] = [];
    const fieldsToCompare: (keyof StudyRoomEntry)[] = [
      "studentName", "guardianName", "email", "phone", "schoolYear", "schoolName", "note", "days", "needsTransport",
      "basePrice", "registration", "insurance", "total", "transportFee"
    ];

    fieldsToCompare.forEach(field => {
      let oldValue = entryToEdit[field];
      let newValue = updatedEntry[field];

      // Handle undefined values for Firestore
      if (newValue === undefined || newValue === "") {
        newValue = null; // Convert undefined or empty string to null for Firestore
      }
      if (oldValue === undefined || oldValue === "") {
        oldValue = null;
      }

      // Special handling for 'days' array comparison
      if (field === "days") {
        const oldDaysNormalized = JSON.stringify((oldValue as any[] || []).map(d => ({ day: d.day, hour: d.hour, transport: d.transport })).sort((a, b) => a.day.localeCompare(b.day)));
        const newDaysNormalized = JSON.stringify((newValue as any[] || []).map(d => ({ day: d.day, hour: d.hour, transport: d.transport })).sort((a, b) => a.day.localeCompare(b.day)));

        if (oldDaysNormalized !== newDaysNormalized) {
          changes.push({
            field: "days",
            oldValue: entryToEdit.days,
            newValue: updatedEntry.days,
            reason: reason,
            timestamp: Timestamp.now(),
          });
        }
      } else if (oldValue !== newValue) {
        changes.push({
          field: String(field),
          oldValue: oldValue,
          newValue: newValue,
          reason: reason,
          timestamp: Timestamp.now(),
        });
      }
    });

    if (changes.length > 0) {
      await studyRoomService.updateStudyRoomEntry(updatedEntry, changes);

      setEntries((prev) =>
        prev.map((entry) =>
          entry.id === updatedEntry.id
            ? { ...entry, ...updatedEntry, entryHistory: [...(entry.entryHistory || []), ...changes] }
            : entry
        )
      );
    }

    setShowEditModal(false);
    setEntryToEdit(null);
  };

  // ---- Derived lists ---------------------------------------------------------

  const pending = useMemo(() => entries.filter((e) => e.status === "pending"), [entries]);
  const confirmed = useMemo(() => entries.filter((e) => e.status === "confirmed"), [entries]);
  const canceled = useMemo(() => entries.filter((e) => e.status === "canceled"), [entries]);
  const archived = useMemo(() => entries.filter((e) => e.status === "archived"), [entries]);

  if (loading) return <div className="p-6 text-center text-gray-500">A carregar…</div>;
  if (err) return <div className="p-6 text-center text-red-500">{err}</div>;

  const renderEntries = (filteredEntries: StudyRoomEntry[]) => (
    filteredEntries.length === 0 ? (
      <p className="text-center text-gray-600">Nenhuma inscrição encontrada.</p>
    ) : (
      <ul className="space-y-4">
        {filteredEntries.map((e) => (
          <StudyRoomEntryCard
            key={e.id}
            entry={e}
            statusBadge={statusBadge}
            statusLabel={statusLabel}
            confirmEntry={confirmEntry}
            cancelEntry={cancelEntry}
            archiveEntry={archiveEntry}
            activateEntry={activateEntry}
            onFileUpload={handleFileUpload}
            onEditEntry={handleEditEntry}
            currentUser={user}
          />
        ))}
      </ul>
    )
  );

  return (
    <div className="p-6 max-w-6xl mx-auto font-[Fredoka] bg-gray-50 min-h-screen">
      <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between mb-8 gap-4">
        <h1 className="text-3xl font-bold text-gray-900">📘 Inscrições — Sala de Estudo</h1>
      </div>

      <div className="mb-6 border-b border-gray-200">
        <ul className="flex -mb-px text-base font-medium text-center" role="tablist">
          <li className="me-2" role="presentation">
            <button
              className={`inline-block p-4 border-b-2 rounded-t-lg transition-colors duration-200 px-4 whitespace-nowrap ${activeTab === "pending" ? "text-blue-600 border-blue-600" : "text-gray-500 hover:text-gray-700 hover:border-gray-300"}`}
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
              className={`inline-block p-4 border-b-2 rounded-t-lg transition-colors duration-200 px-4 whitespace-nowrap ${activeTab === "confirmed" ? "text-blue-600 border-blue-600" : "text-gray-500 hover:text-gray-700 hover:border-gray-300"}`}
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
              className={`inline-block p-4 border-b-2 rounded-t-lg transition-colors duration-200 px-4 whitespace-nowrap ${activeTab === "canceled" ? "text-blue-600 border-blue-600" : "text-gray-500 hover:text-gray-700 hover:border-gray-300"}`}
              onClick={() => setActiveTab("canceled")}
              type="button"
              role="tab"
              aria-selected={activeTab === "canceled"}
            >
              Canceladas ({canceled.length})
            </button>
          </li>
          <li className="me-2" role="presentation">
            <button
              className={`inline-block p-4 border-b-2 rounded-t-lg transition-colors duration-200 px-4 whitespace-nowrap ${activeTab === "archived" ? "text-blue-600 border-blue-600" : "text-gray-500 hover:text-gray-700 hover:border-gray-300"}`}
              onClick={() => setActiveTab("archived")}
              type="button"
              role="tab"
              aria-selected={activeTab === "archived"}
            >
              Arquivadas ({archived.length})
            </button>
          </li>
        </ul>
      </div>

      <div>
        {activeTab === "pending" && renderEntries(pending)}
        {activeTab === "confirmed" && renderEntries(confirmed)}
        {activeTab === "canceled" && renderEntries(canceled)}
        {activeTab === "archived" && renderEntries(archived)}
      </div>

      <ReasonPromptModal
        isOpen={showReasonModal}
        title={currentStatusAction === "confirmed" ? "Confirmar Inscrição" : currentStatusAction === "canceled" ? "Cancelar Inscrição" : currentStatusAction === "archived" ? "Arquivar Inscrição" : "Ativar Inscrição"}
        message={currentStatusAction === "confirmed" ? "Por favor, insira a razão para confirmar esta inscrição:" : currentStatusAction === "canceled" ? "Por favor, insira a razão para cancelar esta inscrição:" : currentStatusAction === "archived" ? "Por favor, insira a razão para arquivar esta inscrição:" : "Por favor, insira a razão para ativar esta inscrição:"}
        onConfirm={handleReasonSubmit}
        onCancel={handleReasonCancel}
        reasonRequired={true}
      />

      {config && (
        <EditStudyRoomModal
          isOpen={showEditModal}
          onClose={() => setShowEditModal(false)}
          entry={entryToEdit}
          onSave={handleSaveEntry}
          priceConfig={config}
        />
      )}
    </div>
  );
}