import { useState } from "react";
import { format } from "date-fns";
import type { StudyRoomEntry, DaySelection, UploadedFile, StatusChangeHistory, EntryChangeHistory } from "@shared/models/StudyRoomEntry";
import { Timestamp } from "firebase/firestore";
import EditHistoryItem from "./EditHistoryItem"; // Import the new component
import { AppUser } from "@shared/models";

type Status = "pending" | "confirmed" | "canceled" | "archived";

interface StudyRoomEntryCardProps {
  entry: StudyRoomEntry;
  statusBadge: (status: Status) => string;
  statusLabel: (status: Status) => string;
  confirmEntry: (id: string) => void;
  cancelEntry: (id: string) => void;
  archiveEntry: (id: string) => void;
  activateEntry: (id: string) => void;
  onFileUpload: (entryId: string, file: File) => Promise<void>;
  onEditEntry: (entry: StudyRoomEntry) => void;
  currentUser: AppUser | null | undefined;
}

const normalizeDays = (days: DaySelection[]): DaySelection[] => {
  if (!Array.isArray(days)) return [];
  return days.map((d: any) => ({
    day: String(d.day),
    hour: d.hour ? String(d.hour) : undefined,
    transport: Boolean(d.transport),
  }));
};

const formatValue = (field: string, value: any) => {
  if (field === "days") {
    if (!Array.isArray(value)) return String(value);
    return value.map(d => `${d.day} (${d.hour || 'N/A'}${d.transport ? ', Transporte' : ''})`).join("; ");
  } else if (typeof value === 'boolean') {
    return value ? 'Sim' : 'Não';
  } else if (value === null || value === undefined) {
    return '—';
  } else if (typeof value === 'object' && value.toDate) {
    return format(value.toDate(), "dd/MM/yyyy HH:mm");
  } else if (typeof value === 'number') {
    return value.toFixed(2);
  }
  return String(value);
};

export default function StudyRoomEntryCard({
  entry,
  statusBadge,
  statusLabel,
  confirmEntry,
  cancelEntry,
  archiveEntry,
  activateEntry,
  onFileUpload,
  onEditEntry,
  currentUser,
}: StudyRoomEntryCardProps) {
  const [activeCardTab, setActiveCardTab] = useState<'student' | 'parent' | 'scheduling' | 'documents' | 'history' | 'editHistory' | 'monthlyPrice'>('student');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>({});

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files[0]) {
      setSelectedFile(event.target.files[0]);
    }
  };

  const handleUpload = async () => {
    if (selectedFile) {
      setUploading(true);
      try {
        await onFileUpload(entry.id, selectedFile);
        setSelectedFile(null);
      } catch (error) {
        console.error("Error uploading file:", error);
        alert("Failed to upload file.");
      } finally {
        setUploading(false);
      }
    }
  };

  // Group edit history by date
  const groupedEditHistory = entry.entryHistory?.reduce((acc, item) => {
    const date = item.timestamp instanceof Timestamp ? format(item.timestamp.toDate(), "dd/MM/yyyy") : "Invalid Date";
    if (!acc[date]) {
      acc[date] = [];
    }
    acc[date].push(item);
    return acc;
  }, {} as Record<string, EntryChangeHistory[]>) || {};

  const toggleDateExpansion = (date: string) => {
    setExpandedDates(prev => ({
      ...prev,
      [date]: !prev[date],
    }));
  };

  const isOwner = currentUser?.roles?.owner === true;

  return (
    <li key={entry.id} className="bg-white border rounded-lg p-4 shadow-md hover:shadow-lg transition-shadow duration-200">
      <div className="flex flex-col md:flex-row items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-4">
            <span className={`px-3 py-1 text-sm font-semibold rounded-full border ${statusBadge(entry.status)}`}>
              {statusLabel(entry.status)}
            </span>
            <h3 className="text-xl font-bold text-gray-900">{entry.studentName}</h3>
          </div>

          <div className="mb-4 border-b border-gray-200">
            <ul className="flex flex-wrap -mb-px text-sm font-medium text-center" role="tablist"> 
              <li className="me-2" role="presentation">
                <button
                  className={`inline-block p-2 border-b-2 rounded-t-lg ${activeCardTab === "student" ? "text-blue-600 border-blue-600" : "hover:text-gray-600 hover:border-gray-300"}`}
                  onClick={() => setActiveCardTab("student")}
                  type="button"
                  role="tab"
                  aria-selected={activeCardTab === "student"}
                >
                  Aluno
                </button>
              </li>
              <li className="me-2" role="presentation">
                <button
                  className={`inline-block p-2 border-b-2 rounded-t-lg ${activeCardTab === "parent" ? "text-blue-600 border-blue-600" : "hover:text-gray-600 hover:border-gray-300"}`}
                  onClick={() => setActiveCardTab("parent")}
                  type="button"
                  role="tab"
                  aria-selected={activeCardTab === "parent"}
                >
                  Encarregado
                </button>
              </li>
              <li className="me-2" role="presentation">
                <button
                  className={`inline-block p-2 border-b-2 rounded-t-lg ${activeCardTab === "scheduling" ? "text-blue-600 border-blue-600" : "hover:text-gray-600 hover:border-gray-300"}`}
                  onClick={() => setActiveCardTab("scheduling")}
                  type="button"
                  role="tab"
                  aria-selected={activeCardTab === "scheduling"}
                >
                  Horário
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
              <li className="me-2" role="presentation">
                <button
                  className={`inline-block p-2 border-b-2 rounded-t-lg ${activeCardTab === "history" ? "text-blue-600 border-blue-600" : "hover:text-gray-600 hover:border-gray-300"}`}
                  onClick={() => setActiveCardTab("history")}
                  type="button"
                  role="tab"
                  aria-selected={activeCardTab === "history"}
                >
                  Histórico Status
                </button>
              </li>
              <li className="me-2" role="presentation">
                <button
                  className={`inline-block p-2 border-b-2 rounded-t-lg ${activeCardTab === "editHistory" ? "text-blue-600 border-blue-600" : "hover:text-gray-600 hover:border-gray-300"}`}
                  onClick={() => setActiveCardTab("editHistory")}
                  type="button"
                  role="tab"
                  aria-selected={activeCardTab === "editHistory"}
                >
                  Histórico Edições
                </button>
              </li>
              {isOwner && (
                <li className="me-2" role="presentation">
                  <button
                    className={`inline-block p-2 border-b-2 rounded-t-lg ${activeCardTab === "monthlyPrice" ? "text-blue-600 border-blue-600" : "hover:text-gray-600 hover:border-gray-300"}`}
                    onClick={() => setActiveCardTab("monthlyPrice")}
                    type="button"
                    role="tab"
                    aria-selected={activeCardTab === "monthlyPrice"}
                  >
                    Preço Mensal
                  </button>
                </li>
              )}
            </ul>
          </div>

          <div>
            {activeCardTab === "student" && (
              <div className="space-y-2">
                <p className="text-gray-600">📚 Ano: {entry.schoolYear}</p>
                <p className="text-sm text-gray-500">
                  <strong className="text-gray-700">🗓️ Submetido:</strong>{" "}
                  {entry.createdAt instanceof Date ? format(entry.createdAt, "dd/MM/yyyy") : "—"}
                </p>
                {entry.statusReason && (
                  <p className="text-sm text-gray-600">
                    <strong className="text-gray-700">💬 Razão:</strong> {entry.statusReason}
                  </p>
                )}
                {entry.note && (
                  <p className="text-sm text-amber-800 bg-amber-50 p-2 rounded-md mt-2 border border-amber-200">
                    <strong className="font-semibold">📝 Observações:</strong> {entry.note}
                  </p>
                )}
              </div>
            )}

            {activeCardTab === "parent" && (
              <div className="space-y-2">
                <p className="text-gray-600">👨‍👩‍👧 Encarregado: {entry.guardianName}</p>
                <p className="text-gray-600">📧 Email: {entry.email}</p>
                <p className="text-gray-600">📞 Telemóvel: {entry.phone}</p>
              </div>
            )}

            {activeCardTab === "scheduling" && (
              <div className="space-y-2">
                <p className="text-gray-600">🏫 Escola: {entry.schoolName}</p>
                <div>
                  <strong className="text-gray-700">📆 Dias:</strong>
                  {entry.days?.length ? (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {normalizeDays(entry.days).map((d, i) => (
                        <span
                          key={`${entry.id}-day-${i}`}
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                            d.transport
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : "bg-blue-50 text-blue-700 border-blue-200"
                          }`}
                        >
                          {d.day}{" "}
                          {d.hour && <span className="ml-1 text-blue-500">{d.hour}</span>}
                          {d.transport && <span className="ml-1.5">🚌</span>}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="ml-1 text-gray-500">—</span>
                  )}
                </div>
              </div>
            )}

            {activeCardTab === "documents" && (
              <div className="flex flex-col md:flex-row gap-4">
                <div className="flex-1 space-y-2">
                  <h4 className="text-lg font-semibold text-gray-800 mb-2">Documentos Carregados</h4>
                  {entry.uploadedFiles && entry.uploadedFiles.length > 0 ? (
                    <ul className="list-disc list-inside space-y-1">
                      {entry.uploadedFiles.map((file, index) => (
                        <li key={index} className="text-gray-600">
                          <a href={file.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                            {file.name} ({format(file.uploadedAt.toDate(), "dd/MM/yyyy")})
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-gray-600">Nenhum documento carregado.</p>
                  )}
                </div>

                <div className="md:w-1/3 space-y-2 mt-4 md:mt-0">
                  <h4 className="text-lg font-semibold text-gray-800 mb-2">Carregar Novo Documento</h4>
                  <input
                    type="file"
                    onChange={handleFileChange}
                    className="block w-full text-sm text-gray-500
                      file:mr-4 file:py-2 file:px-4
                      file:rounded-md file:border-0
                      file:text-sm file:font-semibold
                      file:bg-blue-50 file:text-blue-700
                      hover:file:bg-blue-100"
                  />
                  <button
                    onClick={handleUpload}
                    disabled={!selectedFile || uploading}
                    className="mt-2 px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors duration-200 disabled:bg-gray-400 w-full"
                  >
                    {uploading ? "A carregar..." : "Carregar Documento"}
                  </button>
                </div>
              </div>
            )}

            {activeCardTab === "history" && (
              <div className="space-y-2">
                <h4 className="text-lg font-semibold text-gray-800 mb-2">Histórico de Alterações de Status</h4>
                {entry.statusHistory && entry.statusHistory.length > 0 ? (
                  <ul className="list-disc list-inside space-y-1">
                    {entry.statusHistory.map((historyEntry, index) => (
                      <li key={index} className="text-gray-600">
                        <span className="font-medium">{statusLabel(historyEntry.status)}</span> em {" "}
                        {historyEntry.timestamp instanceof Timestamp ? format(historyEntry.timestamp.toDate(), "dd/MM/yyyy HH:mm") : "—"}
                        {historyEntry.reason && <span className="ml-2 italic">({historyEntry.reason})</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-gray-600">Nenhuma alteração de status registrada.</p>
                )}
              </div>
            )}

            {activeCardTab === "editHistory" && (
              <div className="space-y-2">
                <h4 className="text-lg font-semibold text-gray-800 mb-2">Histórico de Edições</h4>
                {Object.keys(groupedEditHistory).length > 0 ? (
                  <ul className="space-y-4">
                    {Object.keys(groupedEditHistory).sort((a, b) => new Date(b).getTime() - new Date(a).getTime()).map(date => {
                      const isExpanded = expandedDates[date] || false;
                      return (
                        <li key={date} className="bg-gray-100 p-3 rounded-md">
                          <button
                            onClick={() => toggleDateExpansion(date)}
                            className="w-full text-left font-medium text-gray-800 flex justify-between items-center"
                          >
                            <span>
                              {date}
                            </span>
                            <span>{isExpanded ? '▲' : '▼'}</span>
                          </button>
                          {isExpanded && (
                            <ul className="space-y-3 mt-2">
                              {groupedEditHistory[date].map((editEntry, index) => (
                                <EditHistoryItem
                                  key={index}
                                  editEntry={editEntry}
                                  statusLabel={statusLabel}
                                  formatValue={formatValue}
                                />
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}|
                  </ul>
                ) : (
                  <p className="text-gray-600">Nenhuma edição registrada.</p>
                )}
              </div>
            )}

            {isOwner && activeCardTab === "monthlyPrice" && (
              <div className="space-y-2">
                <h4 className="text-lg font-semibold text-gray-800 mb-2">Preço Mensal</h4>
                <p className="text-gray-600">Estudo: €{entry.basePrice?.toFixed(2)}</p>
                <p className="text-gray-600">Transporte: €{entry.transportFee?.toFixed(2)}</p>
                <p className="text-gray-600 font-bold">Total: €{(entry.basePrice + entry.transportFee)?.toFixed(2)}</p>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end justify-start gap-2 mt-4 md:mt-0">
          <button
            onClick={() => onEditEntry(entry)}
            className="text-xs px-3 py-1.5 rounded-md bg-gray-600 text-white hover:bg-gray-700 transition-colors duration-200 shadow-sm w-28 text-center"
            title="Editar inscrição"
          >
            ✏️ Editar
          </button>
          {entry.status === "pending" && (
            <button
              onClick={() => confirmEntry(entry.id)}
              className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors duration-200 shadow-sm w-28 text-center"
              title="Confirmar inscrição"
            >
              ✅ Confirmar
            </button>
          )}
          {(entry.status === "canceled" || entry.status === "archived") && (
            <button
              onClick={() => activateEntry(entry.id)}
              className="text-xs px-3 py-1.5 rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors duration-200 shadow-sm w-28 text-center"
              title="Ativar inscrição"
            >
              🔄 Ativar
            </button>
          )}
          {entry.status !== "canceled" && entry.status !== "archived" && (
            <button
              onClick={() => cancelEntry(entry.id)}
              className="text-xs px-3 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors duration-200 shadow-sm w-28 text-center"
              title="Cancelar inscrição"
            >
              ❌ Cancelar
            </button>
          )}
          {(entry.status === "canceled" || entry.status === "confirmed") && (
            <button
              onClick={() => archiveEntry(entry.id)}
              className="text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors duration-200 shadow-sm w-28 text-center"
              title="Arquivar inscrição"
            >
              📦 Arquivar
            </button>
          )}
        </div>
      </div>
    </li>
  );
}