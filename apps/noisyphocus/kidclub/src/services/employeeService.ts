import { collection, addDoc, getDocs, query, where, doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { AppUser, Role, StudyRoomEntry } from '@shared/models';
import { EmploymentContractDoc } from '@shared/models/Employment';
import { Timestamp } from 'firebase/firestore';

export const employeeService = {
  async getEmployees(): Promise<AppUser[]> {
    const usersSnapshot = await getDocs(collection(db, 'users'));
    const allUsers = usersSnapshot.docs.map(doc => ({ ...doc.data(), uid: doc.id } as AppUser));
    const employees = allUsers.filter(user => user.roles.teacher || user.roles.driver || user.roles.animators);
    return employees;
  },

  async getNonEmployeeUsers(): Promise<AppUser[]> {
    const usersSnapshot = await getDocs(collection(db, 'users'));
    const allUsers = usersSnapshot.docs.map(doc => ({ ...doc.data(), uid: doc.id } as AppUser));
    const nonEmployees = allUsers.filter(user => !user.roles.teacher && !user.roles.driver);
    return nonEmployees;
  },

  async getEmployee(employeeId: string): Promise<AppUser | null> {
    const userDoc = await getDoc(doc(db, 'users', employeeId));
    if (userDoc.exists()) {
      return { ...userDoc.data(), uid: userDoc.id } as AppUser;
    }
    return null;
  },

  async getEmployeeContract(employeeId: string): Promise<EmploymentContractDoc | null> {
    const q = query(collection(db, 'employmentContracts'), where('personId', '==', employeeId));
    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      return null;
    }
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as EmploymentContractDoc;
  },

  async updateEmployee(
    employeeId: string,
    userData: Omit<AppUser, 'uid' | 'createdAt' | 'roles'>,
    role: Role,
    contractData: Omit<EmploymentContractDoc, 'id' | 'orgId' | 'companyId' | 'personId'>
  ): Promise<void> {
    await updateDoc(doc(db, 'users', employeeId), {
      ...userData,
      roles: { [role]: true },
    });

    const contract = await this.getEmployeeContract(employeeId);
    if (contract) {
      await updateDoc(doc(db, 'employmentContracts', contract.id), {
        ...contractData,
      });
    }
  },

  async createUser(userData: Omit<AppUser, 'uid' | 'createdAt' | 'roles'>): Promise<void> {
    await addDoc(collection(db, 'users'), {
      ...userData,
      roles: {},
      createdAt: new Date(),
    });
  },

  async createEmployee(
    userId: string,
    role: Role,
    contractData: Omit<EmploymentContractDoc, 'id' | 'orgId' | 'companyId' | 'personId'>
  ): Promise<void> {
    const userRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userRef);
    if (userDoc.exists()) {
      const user = userDoc.data() as AppUser;
      await updateDoc(userRef, {
        roles: { ...user.roles, [role]: true },
      });
    }

    const newContract: Omit<EmploymentContractDoc, 'id' | 'orgId' | 'companyId'> = {
      ...contractData,
      personId: userId,
      grossMonthlyCents: contractData.grossMonthlyCents ?? null,
      hourlyRateCents: contractData.hourlyRateCents ?? null,
    };
    await addDoc(collection(db, 'employmentContracts'), newContract);
  },

  async generateTeacherTimesheet(date: Date, teacherId: string, endTime: string): Promise<void> {
    console.log(`Generating timesheet for date: ${date.toDateString()}`);
    const dailySchedulesRef = collection(db, 'dailySchedules');
    
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const q = query(dailySchedulesRef, where('date', '>=', Timestamp.fromDate(startOfDay)), where('date', '<=', Timestamp.fromDate(endOfDay)));
    const snapshot = await getDocs(q);
    const dailySchedules = snapshot.docs.map(doc => doc.data());

    console.log(`Found ${dailySchedules.length} daily schedules for ${date.toDateString()}.`);

    if (dailySchedules.length === 0) {
      console.log(`No students found for ${date.toDateString()}`);
      return;
    }

    let earliestHour: string | null = null;

    for (const schedule of dailySchedules) {
      if (!earliestHour || schedule.startTime < earliestHour) {
        earliestHour = schedule.startTime;
      }
    }

    if (!earliestHour) {
      console.log(`No start time found for ${date.toDateString()}`);
      return;
    }

    const [startHour, startMinute] = earliestHour.split(':').map(Number);
    const [endHour, endMinute] = endTime.split(':').map(Number);

    const totalHours = (endHour - startHour) + (endMinute - startMinute) / 60;

    if (totalHours <= 0) {
      console.log(`The calculated hours for ${date.toDateString()} are not positive.`);
      return;
    }

    const newTimesheet = {
      employeeId: teacherId,
      date: Timestamp.fromDate(date),
      hoursWorked: totalHours,
    };

    await addDoc(collection(db, 'timesheets'), newTimesheet);
    console.log(`Timesheet created for ${teacherId} for ${date.toDateString()} with ${totalHours} hours.`);
  },

  async generateTeacherTimesheetsForMonth(month: Date, teacherId: string, endTime: string): Promise<void> {
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, monthIndex, day);
      await this.generateTeacherTimesheet(date, teacherId, endTime);
    }
  },

  async generateDriverTimesheet(date: Date, driverId: string, endTime: string): Promise<void> {
    console.log(`Generating driver timesheet for date: ${date.toDateString()}`);
    const dailySchedulesRef = collection(db, 'dailySchedules');
    
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const q = query(dailySchedulesRef, where('date', '>=', Timestamp.fromDate(startOfDay)), where('date', '<=', Timestamp.fromDate(endOfDay)), where('transport', '==', true));
    const snapshot = await getDocs(q);
    const dailySchedules = snapshot.docs.map(doc => doc.data());

    console.log(`Found ${dailySchedules.length} daily schedules with transport for ${date.toDateString()}.`);

    if (dailySchedules.length === 0) {
      console.log(`No students with transport found for ${date.toDateString()}`);
      return;
    }

    let earliestHour: string | null = null;
    let latestHour: string | null = null;

    for (const schedule of dailySchedules) {
      if (!earliestHour || schedule.startTime < earliestHour) {
        earliestHour = schedule.startTime;
      }
      if (!latestHour || schedule.startTime > latestHour) {
        latestHour = schedule.startTime;
      }
    }

    if (!earliestHour || !latestHour) {
      console.log(`No start or end time found for ${date.toDateString()}`);
      return;
    }

    const [startHour, startMinute] = earliestHour.split(':').map(Number);
    const [endHour, endMinute] = latestHour.split(':').map(Number);

    const totalHours = (endHour - startHour) + (endMinute - startMinute) / 60;

    if (totalHours <= 0) {
      // Assuming driver works at least for one hour
      const newTimesheet = {
        employeeId: driverId,
        date: Timestamp.fromDate(date),
        hoursWorked: 1,
      };
      await addDoc(collection(db, 'timesheets'), newTimesheet);
      console.log(`Timesheet created for ${driverId} for ${date.toDateString()} with 1 hour.`);

    } else {
      const newTimesheet = {
        employeeId: driverId,
        date: Timestamp.fromDate(date),
        hoursWorked: totalHours,
      };
  
      await addDoc(collection(db, 'timesheets'), newTimesheet);
      console.log(`Timesheet created for ${driverId} for ${date.toDateString()} with ${totalHours} hours.`);
    }
  },

  async generateDriverTimesheetsForMonth(month: Date, driverId: string, endTime: string): Promise<void> {
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, monthIndex, day);
      await this.generateDriverTimesheet(date, driverId, endTime);
    }
  }
};