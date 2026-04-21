import { analytics } from './firebase';
import { logEvent } from 'firebase/analytics';

export const trackClick = (eventName: string, payload?: object) => {
  logEvent(analytics, eventName, payload);
};
