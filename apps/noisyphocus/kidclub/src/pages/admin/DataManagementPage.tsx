import { useState, useEffect } from 'react';
import { collection, addDoc, getDocs, deleteDoc, doc } from 'firebase/firestore';
import { db } from '../../lib/firebase';

const FRESH_START_COLLECTIONS = [
  'families',
  'children',
  'studyroom',
  'transportationSubscriptions',
  'bookings',
  'billing',
  'invoices',
  'payments',
] as const;

function FreshStartPanel() {
  const [confirm, setConfirm] = useState('');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  const handleReset = async () => {
    if (confirm !== 'RESET') return;
    setRunning(true);
    setLog([]);
    setDone(false);

    for (const col of FRESH_START_COLLECTIONS) {
      setLog(prev => [...prev, `A limpar ${col}...`]);
      try {
        const snap = await getDocs(collection(db, col));
        for (const d of snap.docs) {
          await deleteDoc(doc(db, col, d.id));
        }
        setLog(prev => [...prev, `  ✓ ${snap.docs.length} documentos eliminados de ${col}`]);
      } catch (e: any) {
        setLog(prev => [...prev, `  ✗ Erro em ${col}: ${e.message}`]);
      }
    }

    setLog(prev => [...prev, '', 'Limpeza concluída.']);
    setDone(true);
    setRunning(false);
    setConfirm('');
  };

  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-6 mb-10">
      <h2 className="text-lg font-bold text-red-900 mb-1">Limpeza Total — Fresh Start</h2>
      <p className="text-sm text-red-700 mb-4">
        Elimina <strong>todos os dados de clientes</strong> — famílias, crianças, inscrições, faturas e pagamentos.
        Configurações, colaboradores e calendário <strong>não são afetados</strong>.
      </p>

      <div className="bg-white rounded border border-red-200 p-4 mb-4 text-sm">
        <p className="font-medium text-gray-700 mb-2">Coleções que serão limpas:</p>
        <ul className="space-y-1">
          {FRESH_START_COLLECTIONS.map(col => (
            <li key={col} className="text-gray-600 flex items-center gap-2">
              <span className="text-red-400">✕</span> {col}
            </li>
          ))}
        </ul>
      </div>

      {!done && (
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-red-800 mb-1">
              Para confirmar, escreva <strong>RESET</strong>:
            </label>
            <input
              type="text"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              disabled={running}
              placeholder="RESET"
              className="w-full px-3 py-2 border border-red-300 rounded-lg focus:ring-2 focus:ring-red-400 text-sm font-mono"
            />
          </div>
          <button
            onClick={handleReset}
            disabled={confirm !== 'RESET' || running}
            className="bg-red-600 text-white px-6 py-2 rounded-lg hover:bg-red-700 disabled:opacity-40 text-sm font-medium"
          >
            {running ? 'A limpar...' : 'Executar Fresh Start'}
          </button>
        </div>
      )}

      {log.length > 0 && (
        <pre className="mt-4 bg-gray-900 text-green-400 text-xs p-4 rounded-lg overflow-auto max-h-48 font-mono">
          {log.join('\n')}
        </pre>
      )}

      {done && (
        <p className="mt-3 text-sm text-green-700 font-medium">
          Base de dados limpa. Pode agora iniciar com dados frescos.
        </p>
      )}
    </div>
  );
}
import { StudyRoomEntry } from '@shared/models'; // Assuming StudyRoomEntry is now in @shared/models

const SAMPLE_STUDY_ROOM_DATA = [
  {
    "studentName": "João Silva",
    "guardianName": "Maria Silva",
    "email": "maria.silva@example.com",
    "phone": "912345678",
    "schoolYear": "3º",
    "schoolName": "Escola Básica do Centro",
    "days": [
      { "day": "monday", "hour": "14:00", "transport": false },
      { "day": "wednesday", "hour": "15:00", "transport": true },
      { "day": "friday", "hour": "16:00", "transport": false }
    ],
    "note": "Aluno com alergia a amendoins.",
    "monthlyPrice": 120.00,
    "startDate": "2024-09-01T00:00:00.000Z",
    "endDate": "2025-07-31T00:00:00.000Z",
    "createdAt": "2024-08-20T10:00:00.000Z",
    "canceled": false,
    "status": "confirmed",
    "needsTransport": true
  },
  {
    "studentName": "Ana Santos",
    "guardianName": "Pedro Santos",
    "email": "pedro.santos@example.com",
    "phone": "934567890",
    "schoolYear": "1º",
    "schoolName": "Colégio da Cidade",
    "days": [
      { "day": "tuesday", "hour": "14:00", "transport": false },
      { "day": "thursday", "hour": "15:00", "transport": false }
    ],
    "note": null,
    "monthlyPrice": 80.00,
    "startDate": "2025-09-01T00:00:00.000Z",
    "endDate": "2026-07-31T00:00:00.000Z",
    "createdAt": "2025-03-15T11:30:00.000Z",
    "canceled": false,
    "status": "pending",
    "needsTransport": false
  },
  {
    "studentName": "Miguel Costa",
    "guardianName": "Sofia Costa",
    "email": "sofia.costa@example.com",
    "phone": "967890123",
    "schoolYear": "5º",
    "schoolName": "Liceu Moderno",
    "days": [
      { "day": "monday", "hour": "16:00", "transport": true },
      { "day": "tuesday", "hour": "16:00", "transport": true },
      { "day": "wednesday", "hour": "16:00", "transport": true },
      { "day": "thursday", "hour": "16:00", "transport": true },
      { "day": "friday", "hour": "16:00", "transport": true }
    ],
    "note": "Necessita de cadeira adaptada.",
    "monthlyPrice": 200.00,
    "startDate": "2024-01-01T00:00:00.000Z",
    "endDate": "2024-06-30T00:00:00.000Z",
    "createdAt": "2023-12-01T09:00:00.000Z",
    "canceled": false,
    "status": "confirmed",
    "needsTransport": true
  }
];

const renderDocumentData = (data: any, collection: string) => {
  if (collection === 'studyroom') {
    return (
      <div>
        <p><strong>Aluno:</strong> {data.studentName}</p>
        <p><strong>Preço Mensal:</strong> €{data.monthlyPrice?.toFixed(2)}</p>
        <p><strong>Início:</strong> {data.startDate?.toDate().toLocaleDateString()}</p>
        <p><strong>Fim:</strong> {data.endDate?.toDate().toLocaleDateString()}</p>
        <p><strong>Status:</strong> {data.status}</p>
      </div>
    );
  }
  // Default to JSON stringify for other collections
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
};

export default function DataManagementPage() {
  const [collectionName, setCollectionName] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [documents, setDocuments] = useState<any[]>([]);
  const [selectedDocuments, setSelectedDocuments] = useState<string[]>([]);

  const fetchDocuments = async () => {
    if (!collectionName) {
      setDocuments([]);
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const snapshot = await getDocs(collection(db, collectionName));
      const docsList = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
      setDocuments(docsList);
    } catch (e: any) {
      setMessage(`Error fetching documents: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, [collectionName]);

  const handleLoadSampleData = async () => {
    if (!collectionName) {
      setMessage('Please select a collection to load sample data into.');
      return;
    }
    if (collectionName !== 'studyroom') {
      setMessage('Sample data is only available for the \'studyroom\' collection.');
      return;
    }

    setLoading(true);
    setMessage('');
    try {
      for (const item of SAMPLE_STUDY_ROOM_DATA) {
        // Convert ISO strings to Date objects for Firestore Timestamp
        const itemToUpload = {
          ...item,
          startDate: new Date(item.startDate),
          endDate: new Date(item.endDate),
          createdAt: new Date(item.createdAt),
        };
        await addDoc(collection(db, collectionName), itemToUpload);
      }
      setMessage(`Successfully loaded ${SAMPLE_STUDY_ROOM_DATA.length} sample documents to ${collectionName}.`);
      fetchDocuments(); // Refresh the list
    } catch (e: any) {
      setMessage(`Error loading sample data: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  

  const handleSelectDocument = (id: string) => {
    setSelectedDocuments(prev =>
      prev.includes(id) ? prev.filter(docId => docId !== id) : [...prev, id]
    );
  };

  const handleDeleteSelected = async () => {
    if (selectedDocuments.length === 0) {
      setMessage('Please select documents to delete.');
      return;
    }

    if (!window.confirm(`Are you sure you want to delete ${selectedDocuments.length} selected documents from the '${collectionName}' collection? This action cannot be undone.`)) {
      return;
    }

    setLoading(true);
    setMessage('');
    try {
      for (const docId of selectedDocuments) {
        await deleteDoc(doc(db, collectionName, docId));
      }
      setMessage(`Successfully deleted ${selectedDocuments.length} selected documents.`);
      setSelectedDocuments([]); // Clear selections
      fetchDocuments(); // Refresh the list
    } catch (e: any) {
      setMessage(`Error deleting selected documents: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAll = async () => {
    if (!collectionName) {
      setMessage('Please select a collection to delete from.');
      return;
    }

    if (!window.confirm(`Are you sure you want to delete ALL documents from the '${collectionName}' collection? This action cannot be undone.`)) {
      return;
    }

    setLoading(true);
    setMessage('');
    try {
      const snapshot = await getDocs(collection(db, collectionName));
      for (const docRef of snapshot.docs) {
        await deleteDoc(doc(db, collectionName, docRef.id));
      }
      setMessage(`Successfully deleted ${snapshot.docs.length} documents from ${collectionName}.`);
    } catch (e: any) {
      setMessage(`Error deleting data: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Gestão de Dados</h1>

      <FreshStartPanel />

      <div className="mb-8">
        <h2 className="text-xl font-bold mb-2">Coleção Firestore</h2>
        <input type="text" value={collectionName} onChange={e => setCollectionName(e.target.value)} className="w-full border rounded px-3 py-2 mt-1" placeholder="e.g., studyroom, bookings, expenses" />
      </div>

      {collectionName && (
        <>
          <div className="mb-8">
            <h2 className="text-xl font-bold mb-2">Ações</h2>
            <div className="flex space-x-4">
              <button onClick={handleLoadSampleData} disabled={loading} className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600 disabled:bg-gray-400">
                {loading ? 'A carregar...' : 'Carregar Dados de Exemplo'}
              </button>
              <button onClick={handleDeleteAll} disabled={loading} className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600 disabled:bg-gray-400">
                {loading ? 'A apagar...' : 'Apagar Todos os Documentos'}
              </button>
            </div>
          </div>

          <div className="mb-8">
            <h2 className="text-xl font-bold mb-2">Documentos em '{collectionName}'</h2>
            {loading ? (
              <p>A carregar documentos...</p>
            ) : (
              <>
                {documents.length === 0 ? (
                  <p>Nenhum documento encontrado.</p>
                ) : (
                  <>
                    <button onClick={handleDeleteSelected} disabled={selectedDocuments.length === 0 || loading} className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600 disabled:bg-gray-400 mb-4">
                      Apagar Selecionados ({selectedDocuments.length})
                    </button>
                    <ul className="space-y-2">
                      {documents.map(doc => (
                        <li key={doc.id} className="border p-4 rounded flex items-center space-x-2">
                          <input
                            type="checkbox"
                            checked={selectedDocuments.includes(doc.id)}
                            onChange={() => handleSelectDocument(doc.id)}
                          />
                          <div className="flex-1 text-sm bg-gray-50 p-2 rounded overflow-auto">
                            {renderDocumentData(doc.data, collectionName)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}

      {message && <p className="mt-4 text-sm text-gray-600">{message}</p>}
    </div>
  );
}
