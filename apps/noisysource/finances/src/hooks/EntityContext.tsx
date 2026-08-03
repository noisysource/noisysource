import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';

export type EntityType = 'private' | 'company';

export type Entity = {
  id: string;
  name: string;
  type: EntityType;
};

export const ENTITIES: Entity[] = [
  { id: 'private',     name: 'Private',     type: 'private' },
  { id: 'noisysource', name: 'NoisySource',  type: 'company' },
  { id: 'noisyphocus', name: 'NoisyPhocus',  type: 'company' },
];

/** Reads the active entity from the URL segment `/:entity/...`.
 *  Falls back to 'private' on global routes (e.g. Dashboard).
 *  Calls api.setEntity() so all domain calls use the correct entity. */
export function useEntity() {
  const params = useParams<{ entity?: string }>();
  const entityId = params.entity ?? 'private';
  const selectedEntity = ENTITIES.find(e => e.id === entityId) ?? ENTITIES[0];

  useEffect(() => {
    api.setEntity(entityId);
  }, [entityId]);

  return { entities: ENTITIES, selectedEntity };
}
