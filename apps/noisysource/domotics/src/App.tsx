import { useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import type {
  Device, DevicePlacement, LightCommand, BlindCommand,
  ThermostatCommand, HeatPumpCommand,
} from '@shared/models/Device';
import type { FloorPlan, InfraItem, PlanRoom, Room, Wall } from '@shared/models/Room';
import type { EditTarget } from './components/FloorPlan';
import { buildDevices } from './data/legrandData';
import { buildTuyaDevices, toTuyaTemp } from './data/tuyaData';
import type { EnergyReading } from './data/energy';
import { fetchBridgeState, sendBridgeCommand } from './lib/bridge';
import { defaultFloorPlan } from './data/houseLayout';
import { db, getStatusFn, setStateFn } from './lib/firebase';
import { watchAuth, signIn, signOutUser, requiresSignIn } from './lib/auth';
import { SignInScreen } from './components/SignInScreen';
import type { User } from 'firebase/auth';
import PlanScreen from './components/PlanScreen';
import RoomDetail from './components/RoomDetail';

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

/** 'offline' means the Legrand gateway didn't answer — the plan still renders. */
export type DeviceStatus = 'loading' | 'ok' | 'offline';

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
  const [energy, setEnergy] = useState<EnergyReading | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget>('rooms');
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const [planSelectedId, setPlanSelectedId] = useState<string | null>(null);
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

  useEffect(() => {
    // Nothing here blocks the first paint: the plan comes from local seed data
    // and renders immediately, so a slow or unreachable gateway costs device
    // state but never the whole UI.
    getStatusFn()
      .then(r => {
        const data = r.data as {
          body?: { home?: { modules?: any[]; errors?: Array<{ code: number; id: string }> } };
        };
        const modules = data?.body?.home?.modules;
        setDevices(buildDevices(modules));
        // Netatmo reports an unreachable gateway as status "ok" with an errors
        // array and no modules — absence of modules is the real signal.
        setDeviceStatus(modules && modules.length > 0 ? 'ok' : 'offline');
      })
      .catch(err => {
        console.error('Failed to load devices:', err);
        setDevices(buildDevices());
        setDeviceStatus('offline');
      });

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
  }, []);

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
    let cancelled = false;

    async function tick() {
      if (document.hidden) return;
      try {
        const state = await fetchBridgeState();
        if (cancelled) return;
        setTuyaDevices(buildTuyaDevices(state.devices ?? []));
        setEnergy(state.inverter ?? null);
        setBridgeStatus('ok');
      } catch {
        if (!cancelled) setBridgeStatus('offline');
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
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

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

  async function handleLightCommand(deviceId: string, command: LightCommand) {
    const current = devices.find(d => d.id === deviceId && d.type === 'light');
    const currentOn = current?.type === 'light' ? current.state.on : false;
    const on = command.action === 'toggle'
      ? !currentOn
      : command.action === 'setOn'
      ? command.on
      : command.brightness > 0;

    setDevices(prev => prev.map(d =>
      d.id !== deviceId || d.type !== 'light' ? d
        : { ...d, state: { ...d.state, on } }
    ));

    try {
      await setStateFn({ modules: [{ id: deviceId, bridge: current?.bridge, on }] });
    } catch (err) {
      console.error('Legrand setstate failed:', err);
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
        await setStateFn({
          modules: [{ id: deviceId, bridge: blindDev?.bridge, target_position }],
        });
      } catch (err) {
        console.error('Legrand setstate failed:', err);
      }
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
      const state = await sendBridgeCommand(deviceId, commands);
      if (state) setTuyaDevices(buildTuyaDevices(state.devices));
    } catch (err) {
      console.error('Bridge command failed:', err);
    }
  }

  async function handleHeatPumpCommand(deviceId: string, command: HeatPumpCommand) {
    setTuyaDevices(prev => prev.map(d =>
      d.id !== deviceId || d.type !== 'heatpump' ? d
        : { ...d, state: { ...d.state, on: command.on } }
    ));

    try {
      const state = await sendBridgeCommand(deviceId, [{ code: 'switch', value: command.on }]);
      if (state) setTuyaDevices(buildTuyaDevices(state.devices));
    } catch (err) {
      console.error('Bridge command failed:', err);
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

  // Served from the public internet, the house is not shown to anyone who has
  // not signed in. On the LAN this is skipped entirely — see requiresSignIn.
  if (requiresSignIn() && !user) {
    return authReady
      ? <SignInScreen onSignIn={signIn} />
      : <div className="h-screen bg-zinc-950" />;
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

  return (
    <PlanScreen
      plan={activePlan}
      devices={effectiveDevices}
      placements={activeCustom.devicePositions}
      deviceStatus={deviceStatus}
      bridgeStatus={bridgeStatus}
      energy={energy}
      user={user}
      onSignIn={signIn}
      onSignOut={signOutUser}
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
