import { Timestamp } from 'firebase/firestore';

export interface DailySchedule {
  id: string;
  studentId: string;
  studentName: string;
  date: Timestamp;
  startTime: string;
  transport: boolean;
}
