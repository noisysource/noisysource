import { createContext, useContext } from 'react';
import { TransportationConfig, TransportationSubscription, SubscriptionSchedule, Location } from '@shared/models/Transportation';

// Add an optional id to the schedule for stable keys
export interface StableSubscriptionSchedule extends SubscriptionSchedule {
    id: string;
}

export interface FormState {
  formData: Partial<TransportationSubscription>;
  schedule: Partial<StableSubscriptionSchedule>[];
  transportationConfig: TransportationConfig | null;
  subtotal: number;
  discount: number;
  featureFlags: any;
}

export interface FormContextProps extends FormState {
  handleChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  handleLocationChange: (name: string, location: Location) => void;
  setSchedule: React.Dispatch<React.SetStateAction<Partial<StableSubscriptionSchedule>[]>>;
  calculatePrice: (schedule: Partial<StableSubscriptionSchedule>[]) => void;
}

export const FormContext = createContext<FormContextProps | undefined>(undefined);

export const useFormContext = () => {
  const context = useContext(FormContext);
  if (!context) {
    throw new Error('useFormContext must be used within a FormProvider');
  }
  return context;
};
