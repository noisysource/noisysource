
export interface ExpenseMapping {
  id: string;
  serviceType: 'party' | 'study';
  serviceName: string;
  rules: ExpenseRule[];
}

export interface ExpenseRule {
  type: 'staff' | 'groceries' | 'extra' | 'transport';
  name: string;
  cost: number;
  unit: 'per_child' | 'per_hour' | 'fixed';
}
