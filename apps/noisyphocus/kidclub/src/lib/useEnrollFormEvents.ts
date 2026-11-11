import { useEffect, useRef } from 'react';
import type { DayConfig } from '../components/WeekSchedulePicker';
import { reportClientEvent, EnrollBlockReason, EnrollService } from './clientEvents';

interface Options {
  service: EnrollService;
  /** False while editing an existing request: edits are never tracked. */
  enabled: boolean;
  /** The form is on screen: finished loading, without a load error. */
  ready: boolean;
  days: DayConfig[];
  submitEnabled: boolean;
}

/**
 * The enrollment steps of one form (see clientEvents.ts). Read-only towards the
 * form: it watches what the page passes in and returns two calls for handleSubmit.
 *
 * enroll_left is the key event. A disabled button emits no click, so leaving is
 * the only trace a parent stuck on one leaves behind.
 */
export function useEnrollFormEvents({ service, enabled, ready, days, submitEnabled }: Options) {
  const studyDays = days.filter(d => d.services?.study).length;
  const transportDays = days.filter(d => (d.services?.transportTrips?.length ?? 0) > 0).length;

  const form = useRef({
    // Kept from the start: by the time an in-app unmount runs, the URL is already the next page's.
    route: window.location.pathname,
    openedAt: null as number | null,
    daysChosen: false,
    submitted: false,
    left: false,
    blocked: new Set<EnrollBlockReason>(),
    leaveTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    // The form as it is now, for the leave handlers below, which outlive any render.
    current: { studyDays, transportDays, tripsMissingAddress: 0, submitEnabled },
  }).current;

  form.current = {
    studyDays,
    transportDays,
    tripsMissingAddress: days
      .flatMap(d => d.services?.transportTrips ?? [])
      .filter(t => !t.pickupAddress?.trim() || !t.dropoffAddress?.trim())
      .length,
    submitEnabled,
  };

  useEffect(() => {
    if (!enabled || !ready || form.openedAt !== null) return;
    form.openedAt = Date.now();
    reportClientEvent('enroll_form_opened', service, {}, { route: form.route });
  }, [enabled, ready, service, form]);

  const anyDayChosen = studyDays + transportDays > 0;
  useEffect(() => {
    if (!anyDayChosen || form.daysChosen || form.openedAt === null) return;
    form.daysChosen = true;
    const { studyDays, transportDays } = form.current;
    reportClientEvent('enroll_days_chosen', service, { studyDays, transportDays }, { route: form.route });
  }, [anyDayChosen, enabled, ready, service, form]);

  useEffect(() => {
    const leave = (unloading: boolean) => {
      if (form.openedAt === null || form.submitted || form.left) return;
      form.left = true;
      reportClientEvent('enroll_left', service, {
        ...form.current,
        seconds: Math.round((Date.now() - form.openedAt) / 1000),
      }, { route: form.route, unloading });
    };
    const onPageHide = () => leave(true);

    // React.StrictMode runs this effect, its cleanup, then the effect again, all
    // in one go. So the cleanup only schedules the leave and a re-run cancels it:
    // that simulated unmount can't produce a false enroll_left.
    clearTimeout(form.leaveTimer);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      form.leaveTimer = setTimeout(() => leave(false), 0);
    };
  }, [service, form]);

  return {
    /** Submit was attempted but stopped. Once per reason, so repeat clicks can't use up the page cap. */
    blocked(reason: EnrollBlockReason) {
      if (form.openedAt === null || form.blocked.has(reason)) return;
      form.blocked.add(reason);
      reportClientEvent('enroll_blocked', service, { reason }, { route: form.route });
    },
    /** After a successful write. */
    submitted() {
      if (form.openedAt === null || form.submitted) return;
      form.submitted = true;
      const { studyDays, transportDays } = form.current;
      reportClientEvent('enroll_submitted', service, { studyDays, transportDays }, { route: form.route });
    },
  };
}
