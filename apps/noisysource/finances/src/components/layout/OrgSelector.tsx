import { useEntity } from '../../hooks/EntityContext';

export function OrgSelector() {
  const { entities, selectedEntity, setSelectedEntityId } = useEntity();

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-zinc-500">Context</label>
      <select
        value={selectedEntity.id}
        onChange={(e) => setSelectedEntityId(e.target.value)}
        className="bg-zinc-800 border border-zinc-700 text-white rounded px-2 py-1 text-sm"
      >
        {entities.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
    </div>
  );
}
