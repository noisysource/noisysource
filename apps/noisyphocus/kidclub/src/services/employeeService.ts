import { collection, addDoc, getDocs, query, where, doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { AppUser, Role } from '@shared/models';
import { EmploymentContractDoc } from '@shared/models/Employment';

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
};
