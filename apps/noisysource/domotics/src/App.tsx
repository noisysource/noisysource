import { useState } from 'react';
import type { Device, LightCommand, BlindCommand } from '@shared/models/Device';
import { initialRooms, initialDevices } from './data/mockData';
import HomeScreen from './components/HomeScreen';
import RoomDetail from './components/RoomDetail';

export default function App() {
  const [devices, setDevices] = useState<Device[]>(initialDevices);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  const selectedRoom = selectedRoomId != null
    ? (initialRooms.find(r => r.id === selectedRoomId) ?? null)
    : null;

  function handleLightCommand(deviceId: string, command: LightCommand) {
    // TODO: call Legrand API / Firestore
    setDevices(prev => prev.map(device => {
      if (device.id !== deviceId || device.type !== 'light') return device;
      if (command.action === 'toggle') {
        return { ...device, state: { ...device.state, on: !device.state.on } };
      }
      if (command.action === 'setOn') {
        return { ...device, state: { ...device.state, on: command.on } };
      }
      // setBrightness
      return {
        ...device,
        state: {
          ...device.state,
          brightness: command.brightness,
          on: command.brightness > 0,
        },
      };
    }));
  }

  function handleBlindCommand(deviceId: string, command: BlindCommand) {
    // TODO: call Legrand API / Firestore
    setDevices(prev => prev.map(device => {
      if (device.id !== deviceId || device.type !== 'blind') return device;
      if (command.action === 'moveUp') {
        return { ...device, state: { ...device.state, isMoving: true, movingDirection: 'up' as const } };
      }
      if (command.action === 'moveDown') {
        return { ...device, state: { ...device.state, isMoving: true, movingDirection: 'down' as const } };
      }
      if (command.action === 'stop') {
        return { ...device, state: { ...device.state, isMoving: false, movingDirection: null } };
      }
      // setPosition
      return {
        ...device,
        state: {
          ...device.state,
          position: command.position,
          isMoving: false,
          movingDirection: null,
        },
      };
    }));
  }

  if (selectedRoom) {
    return (
      <RoomDetail
        room={selectedRoom}
        devices={devices.filter(d => d.roomId === selectedRoom.id)}
        onBack={() => setSelectedRoomId(null)}
        onLightCommand={handleLightCommand}
        onBlindCommand={handleBlindCommand}
      />
    );
  }

  return (
    <HomeScreen
      rooms={initialRooms}
      devices={devices}
      onSelectRoom={setSelectedRoomId}
    />
  );
}
