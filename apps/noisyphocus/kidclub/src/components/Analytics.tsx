import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { analytics } from '../lib/firebase';
import { logEvent } from 'firebase/analytics';

export function Analytics() {
  const location = useLocation();

  useEffect(() => {
    try {
      logEvent(analytics, 'page_view', {
        page_path: location.pathname + location.search,
      });
    } catch { /* analytics unavailable in this environment */ }
  }, [location]);

  return null;
}
