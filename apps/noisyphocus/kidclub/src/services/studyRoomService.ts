import { getDocs, collection, doc, getDoc, setDoc, updateDoc, arrayUnion, Timestamp } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db } from '../lib/firebase';
import { StudyRoomEntry, StudyCenterConfig, EntryChangeHistory } from '@shared/models';
import { safeDate } from '@shared/lib/dates';

type Status = "pending" | "confirmed" | "canceled" | "archived";

export const studyRoomService = {
  async getStudyRoomEntries(): Promise<StudyRoomEntry[]> {
    const entriesSnap = await getDocs(collection(db, "studyroom"));
    const list: StudyRoomEntry[] = entriesSnap.docs.map((d) => {
      const x: any = d.data();
      const s: Status = (x.status as Status) ?? (x.canceled ? "canceled" : "pending");

      return {
        id: d.id,
        studentName: String(x.studentName ?? ""),
        guardianName: String(x.guardianName ?? ""),
        email: String(x.email ?? ""),
        phone: String(x.phone ?? ""),
        schoolYear: String(x.schoolYear ?? ""),
        schoolName: String(x.schoolName ?? ""),
        days: x.days || [],
        note: x.note ? String(x.note) : undefined,
        basePrice: Number(x.basePrice ?? 0),
        registration: Number(x.registration ?? 0),
        insurance: Number(x.insurance ?? 0),
        total: Number(x.total ?? 0),
        transportFee: Number(x.transportFee ?? 0),
        createdAt: safeDate(x.createdAt),
        startDate: safeDate(x.startDate),
        endDate: safeDate(x.endDate),
        canceled: Boolean(x.canceled),
        needsTransport: Boolean(x.needsTransport),
        status: s,
        statusReason: x.statusReason ? String(x.statusReason) : undefined,
        uploadedFiles: x.uploadedFiles || [],
        statusHistory: x.statusHistory || [],
        entryHistory: x.entryHistory || [],
      };
    });
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return list;
  },

  async getStudyCenterConfig(): Promise<StudyCenterConfig | null> {
    const configDocRef = doc(db, 'config', 'studyCenter');
    const configSnap = await getDoc(configDocRef);
    return configSnap.exists() ? configSnap.data() as StudyCenterConfig : null;
  },

  async saveStudyCenterConfig(config: StudyCenterConfig): Promise<void> {
    const configDocRef = doc(db, 'config', 'studyCenter');
    await setDoc(configDocRef, config);
  },

  async updateStudyRoomEntryStatus(id: string, status: Status, reason?: string): Promise<void> {
    const newHistoryEntry = {
      status: status,
      reason: reason,
      timestamp: Timestamp.now(),
    };

    await updateDoc(doc(db, 'studyroom', id), {
      status,
      statusReason: reason,
      statusHistory: arrayUnion(newHistoryEntry),
    });
  },

  async updateStudyRoomEntry(entry: StudyRoomEntry, changes: EntryChangeHistory[]): Promise<void> {
    const dataToUpdate: { [key: string]: any } = {};
    changes.forEach(change => {
      dataToUpdate[change.field] = change.newValue;
    });

    if (Object.keys(dataToUpdate).length > 0) {
      await updateDoc(doc(db, "studyroom", entry.id), {
        ...dataToUpdate,
        entryHistory: arrayUnion(...changes),
      });
    }
  },

  async uploadFile(entryId: string, file: File): Promise<any> {
    const storage = getStorage();
    const storageRef = ref(storage, `studyroom_documents/${entryId}/${file.name}`);

    const snapshot = await uploadBytes(storageRef, file);
    const downloadURL = await getDownloadURL(snapshot.ref);

    const newFile = {
      name: file.name,
      url: downloadURL,
      uploadedAt: Timestamp.now(),
    };

    // Update Firestore document
    const entryDocRef = doc(db, "studyroom", entryId);
    await updateDoc(entryDocRef, {
      uploadedFiles: arrayUnion(newFile),
    });

    return newFile;
  },
};