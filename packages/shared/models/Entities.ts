export type OwnerType = 'company' | 'person';
export type AccountType = 'bank' | 'cash' | 'credit' | 'virtual';

export interface Company {
  id: string;
  name: string;
  taxNumber?: string;
  createdAt: Date;
}

export interface Person {
  id: string;
  name: string;
  email?: string;
  createdAt: Date;
}

export type OrgRole = 'ceo' | 'cfo' | 'worker';

export interface RoleAssignment {
  personId: string;
  companyId: string;
  role: OrgRole;
  salary?: number; // optional unless role requires it
  currency?: string;
  startDate: Date;
  endDate?: Date;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  balance: number;
  archived?: boolean;

  ownerType: OwnerType; // 'company' or 'person'
  ownerId: string;      // references Company.id or Person.id
  createdAt: Date;
}

export type CompanyRoleType = 'CEO' | 'CFO' | 'Worker' | 'Intern';

export interface CompanyRole {
  id: string;
  companyId: string;
  personId: string;
  role: CompanyRoleType;
  salary?: number;
}