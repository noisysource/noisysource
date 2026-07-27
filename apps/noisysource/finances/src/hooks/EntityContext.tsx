import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { api } from '../lib/api';

export type EntityType = 'private' | 'company';

export type Entity = {
  id: string;
  name: string;
  type: EntityType;
};

// The 3 fixed entities — no dynamic fetch needed
export const ENTITIES: Entity[] = [
  { id: 'private', name: 'Private', type: 'private' },
  { id: 'noisysource', name: 'NoisySource', type: 'company' },
  { id: 'noisyphocus', name: 'NoisyPhocus', type: 'company' },
];

interface EntityContextType {
  entities: Entity[];
  selectedEntity: Entity;
  setSelectedEntityId: (entityId: string) => void;
}

const EntityContext = createContext<EntityContextType | undefined>(undefined);

export const EntityProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selectedEntityId, setSelectedEntityId] = useState<string>('private');

  const selectedEntity = ENTITIES.find(e => e.id === selectedEntityId) ?? ENTITIES[0];

  useEffect(() => {
    api.setEntity(selectedEntityId);
  }, [selectedEntityId]);

  const value = useMemo(() => ({
    entities: ENTITIES,
    selectedEntity,
    setSelectedEntityId,
  }), [selectedEntity]);

  return (
    <EntityContext.Provider value={value}>
      {children}
    </EntityContext.Provider>
  );
};

export const useEntity = () => {
  const context = useContext(EntityContext);
  if (context === undefined) {
    throw new Error('useEntity must be used within an EntityProvider');
  }
  return context;
};
