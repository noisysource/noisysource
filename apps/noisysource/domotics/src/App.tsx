import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import type {
  Device, DevicePlacement, LightCommand, BlindCommand,
  ThermostatCommand, HeatPumpCommand,
} from '@shared/models/Device';
import type { FloorPlan, InfraItem, PlanRoom, Room, Wall } from '@shared/models/Room';
import type { EditTarget } from './components/FloorPlan';
import { buildDevices } from './data/legrandData';
import { DEMO, demoAutomation, demoClimate, demoEnergy, demoLegrand } from './data/demoData';
import type { AutomationStatus } from './data/automation';
import type { GuardStatus } from './data/guard';
import { buildTuyaDevices, toTuyaTemp } from './data/tuyaData';
import type { EnergyReading } from './data/energy';
import { announceWatching, fetchBridgeState, sendBridgeCommand } from './lib/bridge';
import { defaultFloorPlan } from './data/houseLayout';
import { db, getStatusFn, setStateFn } from './lib/firebase';
import {
  watchAuth, signIn, signOutUser, requiresSignIn, redirectSignInError, describeSignInError,
  LAN_NO_SIGN_IN,
} from './lib/auth';
import { isLanOrigin } from './lib/origin';
import NoticeToast, { type Notice } from './components/NoticeToast';
import { SignInScreen } from './components/SignInScreen';
import { AdminScreen } from './components/AdminScreen';
import type { User } from 'firebase/auth';
import PlanScreen from './components/PlanScreen';
import HouseScreen from './components/HouseScreen';
import RoomDetail from './components/RoomDetail';

/** Opened rarely, and its charts and printout shouldn't weigh on the everyday screen. */
const ReportsScreen = lazy(() => import('./components/reports/ReportsScreen'));
/** Same for the kWh history and the bill. */
const EnergyScreen = lazy(() => import('./components/energy/EnergyScreen'));

/**
 * Per-device overrides. Room names used to live here too; they now belong to
 * the floor plan document, which is the single source of truth for a room's
 * identity. Older `roomNames` keys still on disk are simply ignored.
 */
export interface Customization {
  deviceNames: Record<string, string>;
  deviceRooms: Record<string, string>;
  /** Where each device sits inside its room. Absent = auto-arranged. */
  devicePositions: Record<string, DevicePlacement>;
}

export interface EditProps {
  editMode: boolean;
  allRooms: Room[];
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => Promise<void>;
  onRoomNameChange: (roomId: string, name: string) => void;
  onDeviceNameChange: (deviceId: string, name: string) => void;
  onDeviceRoomChange: (deviceId: string, roomId: string) => void;
}

interface Draft {
  plan: FloorPlan;
  customization: Customization;
}

/**
 * 'offline' means the Legrand gateway didn't answer — the plan still renders.
 * 'signin' means it was never asked: the Legrand callables need an identity,
 * which on the LAN nothing else does, so this is the normal state until
 * someone signs in — not a fault, and it must not read like one.
 */
export type DeviceStatus = 'loading' | 'ok' | 'offline' | 'signin';

/**
 * A bridge miss on the very first load is common — the Pi is a 700MHz board
 * and can be mid-poll when asked — and the normal 30s interval would leave
 * "offline" on screen for half a minute over one dropped request. So a failure
 * is retried quickly a few times, and only reported once it repeats.
 */
const BRIDGE_RETRY_MS = 4000;
const BRIDGE_FAILS_BEFORE_OFFLINE = 2;

/** Lights and blinds are re-read on return to the app, but no more often than this. */
const LEGRAND_REFRESH_MIN_MS = 60_000;

const VIEW_PREF = 'domotics.view';
type View = '3d' | '2d';

function initialView(): View {
  try {
    return localStorage.getItem(VIEW_PREF) === '2d' ? '2d' : '3d';
  } catch {
    return '3d';
  }
}

const EMPTY: Customization = { deviceNames: {}, deviceRooms: {}, devicePositions: {} };
const CONFIG_REF = () => doc(db, 'domotics_config', 'customization');
const PLAN_REF = () => doc(db, 'domotics_config', 'floorplan');

export default function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [tuyaDevices, setTuyaDevices] = useState<Device[]>([]);
  const [plan, setPlan] = useState<FloorPlan>(defaultFloorPlan);
  const [customization, setCustomization] = useState<Customization>(EMPTY);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>('loading');
  const [bridgeStatus, setBridgeStatus] = useState<DeviceStatus>('loading');
  /** When the bridge last published, so the admin screen can flag it offline. */
  const [bridgeUpdatedAt, setBridgeUpdatedAt] = useState<number | undefined>();
  const [showAdmin, setShowAdmin] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [showEnergy, setShowEnergy] = useState(false);
  const [energy, setEnergy] = useState<EnergyReading | null>(null);
  /** The heating automation's latest decision, reported by the bridge with its state. */
  const [automation, setAutomation] = useState<AutomationStatus | undefined>();
  /** The E13 guard's status, reported the same way. */
  const [guard, setGuard] = useState<GuardStatus | undefined>();
  const [editTarget, setEditTarget] = useState<EditTarget>('rooms');
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const [planSelectedId, setPlanSelectedId] = useState<string | null>(null);
  /** The 3D house for everyday use; the 2D plan for editing and the detailed layers. */
  const [view, setView] = useState<View>(initialView);
  /**
   * Only needed for the relay — the LAN path works signed out, and being
   * unable to sign in should never stop you controlling the house from inside
   * it. So this gates nothing in the UI; it just supplies an identity when one
   * is available.
   */
  const [user, setUser] = useState<User | null>(null);
  /**
   * Firebase restores an existing session asynchronously, so `user` is null for
   * a moment on every load. Without this the sign-in screen flashes up in front
   * of someone who is already signed in.
   */
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => watchAuth(u => { setUser(u); setAuthReady(true); }), []);

  const [notice, setNotice] = useState<Notice | null>(null);
  const notify = (text: string) => setNotice({ id: Date.now(), text });
  const clearNotice = useCallback(() => setNotice(null), []);

  // Back from a redirect sign-in (the installed app): success arrives through
  // watchAuth; a failure only shows up here, so it has to be asked for.
  useEffect(() => {
    void redirectSignInError().then(err => { if (err) notify(describeSignInError(err)); });
  }, []);

  /** Sign-in from the header and chips. Says why instead of failing silently. */
  async function requestSignIn() {
    if (isLanOrigin()) {
      notify(LAN_NO_SIGN_IN);
      return;
    }
    try {
      await signIn();
    } catch (err) {
      notify(describeSignInError(err));
    }
  }

  /** Every Legrand write goes through here, so demo mode can keep it on screen. */
  async function legrandSet(payload: Parameters<typeof setStateFn>[0]) {
    if (DEMO) return;
    await setStateFn(payload);
  }

  function legrandFailed(err: unknown) {
    console.error('Legrand setstate failed:', err);
    const code = (err as { code?: string })?.code;
    notify(
      code === 'functions/unauthenticated'
        ? isLanOrigin()
          ? `As luzes e estores precisam de sessão iniciada. ${LAN_NO_SIGN_IN}`
          : 'Inicie sessão para controlar as luzes e estores.'
        : code === 'functions/permission-denied'
        ? 'Esta conta não tem acesso às luzes e estores.'
        : 'As luzes e estores não responderam. Tente de novo.',
    );
  }

  /**
   * Gated pages must not do any work.
   *
   * An early return does not stop effects — hooks run on every render — so
   * without this the sign-in screen still called the gateway and polled
   * Firestore, where every relay read is denied and the SDK retries the
   * connection indefinitely. The visible symptom was the browser's network
   * panel filling with failures fast enough to lock up devtools.
   */
  const gated = requiresSignIn() && !user;

  /**
   * Legrand state. Keyed on the user as well, because on the LAN the page
   * loads signed out and the callable refuses until someone signs in — without
   * re-running here, signing in would change nothing until a reload.
   */
  const uid = user?.uid;
  useEffect(() => {
    if (gated) return;
    if (DEMO) {
      setDevices(demoLegrand());
      setDeviceStatus('ok');
      return;
    }
    let cancelled = false;
    let loadedAt = 0;

    // Nothing here blocks the first paint: the plan comes from local seed data
    // and renders immediately, so a slow or unreachable gateway costs device
    // state but never the whole UI.
    function load() {
      const first = loadedAt === 0;
      loadedAt = Date.now();
      getStatusFn()
        .then(r => {
          if (cancelled) return;
          const data = r.data as {
            body?: { home?: { modules?: any[]; errors?: Array<{ code: number; id: string }> } };
          };
          const modules = data?.body?.home?.modules;
          // Netatmo reports an unreachable gateway as status "ok" with an errors
          // array and no modules — absence of modules is the real signal.
          if (modules && modules.length > 0) {
            setDevices(buildDevices(modules));
            setDeviceStatus('ok');
          } else if (first) {
            setDevices(buildDevices(modules));
            setDeviceStatus('offline');
          }
        })
        .catch(err => {
          if (cancelled) return;
          // A failed refresh keeps what was already on screen; only the first
          // load falls back to the seed list, so there is something to draw.
          if (first) setDevices(buildDevices());
          if ((err as { code?: string })?.code === 'functions/unauthenticated') {
            setDeviceStatus('signin');
            return;
          }
          console.error('Failed to load devices:', err);
          if (first) setDeviceStatus('offline');
        });
    }

    /**
     * Re-read when the app comes back to the foreground. An installed phone app
     * is resumed, not reloaded, so without this it would show the lights as
     * they were hours ago. Only on return and at most once a minute — Netatmo
     * is a metered, rate-limited API, so this is deliberately not a poll.
     */
    function onVisible() {
      if (!document.hidden && Date.now() - loadedAt > LEGRAND_REFRESH_MIN_MS) load();
    }

    load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [gated, uid]);

  useEffect(() => {
    if (gated) return;
    getDoc(CONFIG_REF())
      .then(snap => {
        if (snap.exists()) {
          const d = snap.data() as Partial<Customization>;
          setCustomization({
            deviceNames: d.deviceNames ?? {},
            deviceRooms: d.deviceRooms ?? {},
            devicePositions: d.devicePositions ?? {},
          });
        }
      })
      .catch(() => {});

    // Fall back to the traced seed plan until the house has been laid out once.
    getDoc(PLAN_REF())
      .then(snap => {
        if (snap.exists()) setPlan(snap.data() as FloorPlan);
      })
      .catch(() => {});
  }, [gated]);

  /**
   * Climate state refresh.
   *
   * Thermostats change slowly, and each fetch tells the bridge someone is
   * watching — which is what makes it poll the actual hardware faster. So this
   * interval is deliberately unhurried, and stops entirely when the tab is
   * hidden: a forgotten background tab should not keep the radiator valves
   * awake. Setting a temperature does not wait for it, because the command
   * response carries freshly read state.
   */
  useEffect(() => {
    if (gated) return;
    if (DEMO) {
      setTuyaDevices(demoClimate());
      setEnergy(demoEnergy());
      setAutomation(demoAutomation());
      setBridgeUpdatedAt(Date.now());
      setBridgeStatus('ok');
      return;
    }
    let cancelled = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      if (document.hidden) return;
      clearTimeout(retry);
      try {
        const state = await fetchBridgeState();
        if (cancelled) return;
        failures = 0;
        setTuyaDevices(buildTuyaDevices(state.devices ?? []));
        setEnergy(state.inverter ?? null);
        setAutomation(state.automation);
        setGuard(state.guard);
        setBridgeUpdatedAt(state.updatedAt);
        setBridgeStatus('ok');
        void announceWatching();
      } catch {
        if (cancelled) return;
        failures++;
        if (failures >= BRIDGE_FAILS_BEFORE_OFFLINE) setBridgeStatus('offline');
        // Quick retries only; a bridge that stays down falls back to the
        // normal interval rather than being hammered every few seconds.
        if (failures <= BRIDGE_FAILS_BEFORE_OFFLINE + 1) {
          retry = setTimeout(() => void tick(), BRIDGE_RETRY_MS);
        }
      }
    }

    // Refresh immediately on return, rather than leaving stale numbers on
    // screen until the next tick.
    function onVisible() {
      if (!document.hidden) void tick();
    }

    void tick();
    const id = setInterval(() => void tick(), 30_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [gated]);

  const editMode = draft !== null;
  const activePlan = draft?.plan ?? plan;
  const activeCustom = draft?.customization ?? customization;

  const allDevices = [...devices, ...tuyaDevices];

  const effectiveDevices = allDevices.map(d => ({
    ...d,
    name: activeCustom.deviceNames[d.id] ?? d.name,
    roomId: activeCustom.deviceRooms[d.id] ?? d.roomId,
  }));

  function startEdit() {
    setDraft({ plan: structuredClone(plan), customization: structuredClone(customization) });
  }

  function cancelEdit() {
    setDraft(null);
    setPlanSelectedId(null);
  }

  async function saveEdit() {
    if (!draft) return;
    try {
      await Promise.all([
        setDoc(PLAN_REF(), draft.plan),
        setDoc(CONFIG_REF(), draft.customization),
      ]);
      setPlan(draft.plan);
      setCustomization(draft.customization);
    } catch (err) {
      console.error('Failed to save config:', err);
      notify('Não foi possível guardar a planta.');
    }
    setDraft(null);
    setPlanSelectedId(null);
  }

  function changeRooms(rooms: PlanRoom[]) {
    setDraft(d => (d ? { ...d, plan: { ...d.plan, rooms } } : d));
  }

  function changeInfra(items: InfraItem[]) {
    setDraft(d => (d ? { ...d, plan: { ...d.plan, infrastructure: items } } : d));
  }

  function changeWalls(walls: Wall[]) {
    setDraft(d => (d ? { ...d, plan: { ...d.plan, walls } } : d));
  }

  function updateRoomName(roomId: string, name: string) {
    setDraft(d => d ? {
      ...d,
      plan: {
        ...d.plan,
        rooms: d.plan.rooms.map(r => (r.id === roomId ? { ...r, name } : r)),
      },
    } : d);
  }

  function updateDeviceName(deviceId: string, name: string) {
    setDraft(d => d ? {
      ...d,
      customization: {
        ...d.customization,
        deviceNames: { ...d.customization.deviceNames, [deviceId]: name },
      },
    } : d);
  }

  /** Drag-drop from the plan: room assignment and position move together. */
  function placeDevice(deviceId: string, roomId: string, rx: number, ry: number) {
    setDraft(d => d ? {
      ...d,
      customization: {
        ...d.customization,
        deviceRooms: { ...d.customization.deviceRooms, [deviceId]: roomId },
        devicePositions: { ...d.customization.devicePositions, [deviceId]: { rx, ry } },
      },
    } : d);
  }

  function moveDevice(deviceId: string, roomId: string) {
    setDraft(d => d ? {
      ...d,
      customization: {
        ...d.customization,
        deviceRooms: { ...d.customization.deviceRooms, [deviceId]: roomId },
      },
    } : d);
  }

  /**
   * Undo an optimistic update after a Legrand command fails. Without this the
   * screen showed the light on even when the call was refused (signed out,
   * gateway down) — tolerable on a desk, misleading on a phone away from home,
   * where the screen is the only way of knowing what the house is doing.
   * `devices` here is the state from before the optimistic update.
   */
  function restoreDevices(deviceIds: string[]) {
    const before = new Map(devices.filter(d => deviceIds.includes(d.id)).map(d => [d.id, d]));
    setDevices(prev => prev.map(d => before.get(d.id) ?? d));
  }

  async function handleLightCommand(deviceId: string, command: LightCommand) {
    const current = devices.find(d => d.id === deviceId && d.type === 'light');
    const currentOn = current?.type === 'light' ? current.state.on : false;
    const on = command.action === 'toggle'
      ? !currentOn
      : command.action === 'setOn'
      ? command.on
      : command.brightness > 0;
    // Only dimmers take a level; zero means off, and the last level is kept so
    // switching back on doesn't jump to full.
    const dimmable = current?.type === 'light' && current.state.dimmable;
    const brightness = command.action === 'setBrightness' && dimmable && command.brightness > 0
      ? Math.round(Math.min(100, command.brightness))
      : undefined;

    setDevices(prev => prev.map(d =>
      d.id !== deviceId || d.type !== 'light' ? d
        : { ...d, state: { ...d.state, on, ...(brightness !== undefined ? { brightness } : {}) } }
    ));

    try {
      await legrandSet({
        modules: [{
          id: deviceId, bridge: current?.bridge, on,
          ...(brightness !== undefined ? { brightness } : {}),
        }],
      });
    } catch (err) {
      legrandFailed(err);
      restoreDevices([deviceId]);
    }
  }

  async function handleBlindCommand(deviceId: string, command: BlindCommand) {
    const blindDev = devices.find(d => d.id === deviceId && d.type === 'blind');
    let target_position: number | undefined;
    let isMoving = false;
    let movingDirection: 'up' | 'down' | null = null;

    if (command.action === 'moveUp') {
      target_position = 100;
      isMoving = true;
      movingDirection = 'up';
    } else if (command.action === 'moveDown') {
      target_position = 0;
      isMoving = true;
      movingDirection = 'down';
    } else if (command.action === 'stop') {
      const cur = blindDev?.type === 'blind' ? blindDev.state.position : 50;
      target_position = cur;
    } else {
      target_position = command.position;
    }

    setDevices(prev => prev.map(d =>
      d.id !== deviceId || d.type !== 'blind' ? d
        : { ...d, state: { ...d.state, isMoving, movingDirection, position: target_position ?? d.state.position } }
    ));

    if (target_position !== undefined) {
      try {
        await legrandSet({
          modules: [{ id: deviceId, bridge: blindDev?.bridge, target_position }],
        });
      } catch (err) {
        legrandFailed(err);
        restoreDevices([deviceId]);
      }
    }
  }

  /**
   * Several lights at once ("Apagar todas"). One setstate call carrying every
   * module, not one call per light: Netatmo is rate-limited per user, and a
   * whole-house switch-off should cost the same as switching one light.
   */
  async function handleLightsSet(deviceIds: string[], on: boolean) {
    const ids = new Set(deviceIds);
    const targets = devices.filter(d => d.type === 'light' && ids.has(d.id));
    if (targets.length === 0) return;
    setDevices(prev => prev.map(d =>
      d.type !== 'light' || !ids.has(d.id) ? d : { ...d, state: { ...d.state, on } }
    ));
    try {
      await legrandSet({ modules: targets.map(d => ({ id: d.id, bridge: d.bridge, on })) });
    } catch (err) {
      legrandFailed(err);
      restoreDevices(deviceIds);
    }
  }

  /** Several blinds to one position, in a single call — same reasoning as lights. */
  async function handleBlindsSet(deviceIds: string[], position: number) {
    const ids = new Set(deviceIds);
    const targets = devices.filter(d => d.type === 'blind' && ids.has(d.id));
    if (targets.length === 0) return;
    setDevices(prev => prev.map(d =>
      d.type !== 'blind' || !ids.has(d.id) ? d : { ...d, state: { ...d.state, position } }
    ));
    try {
      await legrandSet({
        modules: targets.map(d => ({ id: d.id, bridge: d.bridge, target_position: position })),
      });
    } catch (err) {
      legrandFailed(err);
      restoreDevices(deviceIds);
    }
  }

  async function handleThermostatCommand(deviceId: string, command: ThermostatCommand) {
    setTuyaDevices(prev => prev.map(d =>
      d.id !== deviceId || d.type !== 'thermostat' ? d
        : {
            ...d,
            state: command.action === 'setTarget'
              ? { ...d.state, target: command.target }
              : { ...d.state, mode: command.mode },
          }
    ));

    const commands = command.action === 'setTarget'
      ? [{ code: 'temp_set', value: toTuyaTemp(command.target) }]
      : [{ code: 'mode', value: command.mode }];

    try {
      // The bridge answers with freshly read state, so the optimistic guess is
      // replaced by the truth immediately rather than at the next poll.
      const state = DEMO ? null : await sendBridgeCommand(deviceId, commands);
      if (state) setTuyaDevices(buildTuyaDevices(state.devices));
    } catch (err) {
      console.error('Bridge command failed:', err);
      notify('O comando de clima não chegou à casa. Tente de novo.');
    }
  }

  async function handleHeatPumpCommand(deviceId: string, command: HeatPumpCommand) {
    setTuyaDevices(prev => prev.map(d =>
      d.id !== deviceId || d.type !== 'heatpump' ? d
        : { ...d, state: { ...d.state, on: command.on } }
    ));

    try {
      const state = DEMO ? null : await sendBridgeCommand(deviceId, [{ code: 'switch', value: command.on }]);
      if (state) setTuyaDevices(buildTuyaDevices(state.devices));
    } catch (err) {
      console.error('Bridge command failed:', err);
      notify('O comando de clima não chegou à casa. Tente de novo.');
    }
  }

  const editProps: EditProps = {
    editMode,
    allRooms: activePlan.rooms,
    onStartEdit: startEdit,
    onCancelEdit: cancelEdit,
    onSaveEdit: saveEdit,
    onRoomNameChange: updateRoomName,
    onDeviceNameChange: updateDeviceName,
    onDeviceRoomChange: moveDevice,
  };

  const openRoom = openRoomId != null
    ? (activePlan.rooms.find(r => r.id === openRoomId) ?? null)
    : null;

  return (
    <>
      {renderScreen()}
      {notice && <NoticeToast notice={notice} onClose={clearNotice} />}
    </>
  );

  function renderScreen() {
    // Served from the public internet, the house is not shown to anyone who has
    // not signed in. On the LAN this is skipped entirely — see requiresSignIn.
    if (gated) {
      return authReady
        ? <SignInScreen onSignIn={signIn} />
        : <div className="h-screen bg-zinc-950" />;
    }

    if (showAdmin) {
      return (
        <AdminScreen
          onBack={() => setShowAdmin(false)}
          bridgeUpdatedAt={bridgeUpdatedAt}
        />
      );
    }

    if (showReports) {
      return (
        <Suspense fallback={<div className="h-screen bg-zinc-950" />}>
          <ReportsScreen
            onBack={() => setShowReports(false)}
            guard={guard}
            // Owner-only data; on the LAN nobody can sign in.
            canRead={!!user && !isLanOrigin()}
          />
        </Suspense>
      );
    }

    if (showEnergy) {
      return (
        <Suspense fallback={<div className="h-screen bg-zinc-950" />}>
          <EnergyScreen
            onBack={() => setShowEnergy(false)}
            // Owner-only data, like the reports; demo mode makes its own.
            canRead={DEMO || (!!user && !isLanOrigin())}
            live={energy}
          />
        </Suspense>
      );
    }

    if (openRoom) {
      return (
        <RoomDetail
          room={openRoom}
          devices={effectiveDevices.filter(d => d.roomId === openRoom.id)}
          onBack={() => setOpenRoomId(null)}
          onLightCommand={handleLightCommand}
          onBlindCommand={handleBlindCommand}
          {...editProps}
        />
      );
    }

    function showView(next: View) {
      setView(next);
      try { localStorage.setItem(VIEW_PREF, next); } catch { /* not persisted */ }
    }

    // Editing always happens on the 2D plan; when it ends, whichever view was
    // in use comes back.
    if (view === '3d' && !editMode) {
      return (
        <HouseScreen
          plan={activePlan}
          devices={effectiveDevices}
          placements={activeCustom.devicePositions}
          deviceStatus={deviceStatus}
          bridgeStatus={bridgeStatus}
          bridgeUpdatedAt={bridgeUpdatedAt}
          energy={energy}
          user={user}
          onSignIn={requestSignIn}
          onSignOut={signOutUser}
          onOpenAdmin={() => setShowAdmin(true)}
          onOpenReports={() => setShowReports(true)}
          onOpenEnergy={user || DEMO ? () => setShowEnergy(true) : undefined}
          onShow2D={() => showView('2d')}
          onStartEdit={startEdit}
          onLightCommand={handleLightCommand}
          onLightsSet={handleLightsSet}
          onBlindCommand={handleBlindCommand}
          onBlindsSet={handleBlindsSet}
          onThermostatCommand={handleThermostatCommand}
          onHeatPumpCommand={handleHeatPumpCommand}
          automation={automation}
          guard={guard}
          // The settings document is the owner's alone; on the LAN nobody can sign in.
          canEditAutomation={!!user && !isLanOrigin()}
        />
      );
    }

    return (
      <PlanScreen
        plan={activePlan}
        devices={effectiveDevices}
        placements={activeCustom.devicePositions}
        deviceStatus={deviceStatus}
        bridgeStatus={bridgeStatus}
        bridgeUpdatedAt={bridgeUpdatedAt}
        energy={energy}
        user={user}
        onSignIn={requestSignIn}
        onSignOut={signOutUser}
        onOpenAdmin={() => setShowAdmin(true)}
        onOpenReports={() => setShowReports(true)}
        onOpenEnergy={user || DEMO ? () => setShowEnergy(true) : undefined}
        onShow3D={() => showView('3d')}
        editMode={editMode}
        editTarget={editTarget}
        selectedId={planSelectedId}
        onEditTargetChange={setEditTarget}
        onSelect={setPlanSelectedId}
        onOpenRoom={setOpenRoomId}
        onChangeRooms={changeRooms}
        onChangeInfra={changeInfra}
        onChangeWalls={changeWalls}
        onPlaceDevice={placeDevice}
        onDeviceNameChange={updateDeviceName}
        onLightCommand={handleLightCommand}
        onBlindCommand={handleBlindCommand}
        onThermostatCommand={handleThermostatCommand}
        onHeatPumpCommand={handleHeatPumpCommand}
        onStartEdit={startEdit}
        onCancelEdit={cancelEdit}
        onSaveEdit={saveEdit}
      />
    );
  }
}
