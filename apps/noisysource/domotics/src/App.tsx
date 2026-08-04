import { useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import type { Device, LightCommand, BlindCommand } from '@shared/models/Device';
import type { Room } from '@shared/models/Room';
import { rooms as baseRooms, buildDevices } from './data/legrandData';
import { db, getStatusFn, setStateFn } from './lib/firebase';
import HomeScreen from './components/HomeScreen';
import RoomDetail from './components/RoomDetail';

export interface Customization {
  roomNames: Record<string, string>;
  deviceNames: Record<string, string>;
  deviceRooms: Record<string, string>;
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

const EMPTY: Customization = { roomNames: {}, deviceNames: {}, deviceRooms: {} };
const CONFIG_REF = () => doc(db, 'domotics_config', 'customization');

export default function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [customization, setCustomization] = useState<Customization>(EMPTY);
  const [editDraft, setEditDraft] = useState<Customization | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  useEffect(() => {
    // Load devices — drives the loading spinner
    getStatusFn()
      .then(r => {
        const data = r.data as { body: { home: { modules: any[] } } };
        setDevices(buildDevices(data.body.home.modules));
      })
      .catch(err => console.error('Failed to load devices:', err))
      .finally(() => setLoading(false));

    // Load saved customization — non-fatal, empty defaults if missing
    getDoc(CONFIG_REF())
      .then(snap => {
        if (snap.exists()) setCustomization(snap.data() as Customization);
      })
      .catch(() => {});
  }, []);

  const editMode = editDraft !== null;
  const draft = editDraft ?? customization;

  const effectiveRooms = baseRooms.map(r => ({
    ...r,
    name: draft.roomNames[r.id] ?? r.name,
  }));

  const effectiveDevices = devices.map(d => ({
    ...d,
    name: draft.deviceNames[d.id] ?? d.name,
    roomId: draft.deviceRooms[d.id] ?? d.roomId,
  }));

  function startEdit() {
    setEditDraft({ ...customization });
  }

  function cancelEdit() {
    setEditDraft(null);
  }

  async function saveEdit() {
    if (!editDraft) return;
    try {
      await setDoc(CONFIG_REF(), editDraft);
      setCustomization(editDraft);
    } catch (err) {
      console.error('Failed to save config:', err);
    }
    setEditDraft(null);
  }

  function updateRoomName(roomId: string, name: string) {
    setEditDraft(d => d ? { ...d, roomNames: { ...d.roomNames, [roomId]: name } } : d);
  }

  function updateDeviceName(deviceId: string, name: string) {
    setEditDraft(d => d ? { ...d, deviceNames: { ...d.deviceNames, [deviceId]: name } } : d);
  }

  function moveDevice(deviceId: string, roomId: string) {
    setEditDraft(d => d ? { ...d, deviceRooms: { ...d.deviceRooms, [deviceId]: roomId } } : d);
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
      await setStateFn({ modules: [{ id: deviceId, on }] });
    } catch (err) {
      console.error('Legrand setstate failed:', err);
    }
  }

  async function handleBlindCommand(deviceId: string, command: BlindCommand) {
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
      const blindDev = devices.find(d => d.id === deviceId && d.type === 'blind');
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
        await setStateFn({ modules: [{ id: deviceId, target_position }] });
      } catch (err) {
        console.error('Legrand setstate failed:', err);
      }
    }
  }

  const editProps: EditProps = {
    editMode,
    allRooms: effectiveRooms,
    onStartEdit: startEdit,
    onCancelEdit: cancelEdit,
    onSaveEdit: saveEdit,
    onRoomNameChange: updateRoomName,
    onDeviceNameChange: updateDeviceName,
    onDeviceRoomChange: moveDevice,
  };

  const selectedRoom = selectedRoomId != null
    ? (effectiveRooms.find(r => r.id === selectedRoomId) ?? null)
    : null;

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-400 text-lg">
        A carregar dispositivos…
      </div>
    );
  }

  if (selectedRoom) {
    return (
      <RoomDetail
        room={selectedRoom}
        devices={effectiveDevices.filter(d => d.roomId === selectedRoom.id)}
        onBack={() => setSelectedRoomId(null)}
        onLightCommand={handleLightCommand}
        onBlindCommand={handleBlindCommand}
        {...editProps}
      />
    );
  }

  return (
    <HomeScreen
      rooms={effectiveRooms}
      devices={effectiveDevices}
      onSelectRoom={setSelectedRoomId}
      {...editProps}
    />
  );
}
