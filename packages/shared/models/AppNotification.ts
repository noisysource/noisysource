export type NotificationType = 'insurance_renewal' | 'generic';
export type NotificationSeverity = 'info' | 'warning' | 'urgent';

export interface AppNotification {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  read: boolean;
  entityId?: string;
  referenceId?: string;
  referenceType?: string;
  linkTo?: string;
  dueDate?: string;
  createdAt?: Date;
}
