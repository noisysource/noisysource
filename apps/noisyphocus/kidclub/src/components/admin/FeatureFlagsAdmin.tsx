import { useEffect, useState } from 'react';
import { getFeatureFlags, updateFeatureFlags } from '../../services/featureFlagsService';
import { FeatureFlags } from '@shared/models/FeatureFlags';
import * as Switch from '@radix-ui/react-switch';

export default function FeatureFlagsAdmin() {
  const [flags, setFlags] = useState<FeatureFlags>({});
  const [newFlagName, setNewFlagName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchFlags = async () => {
      try {
        const fetchedFlags = await getFeatureFlags();
        setFlags(fetchedFlags);
      } catch (err) {
        setError('Failed to load feature flags.');
      } finally {
        setLoading(false);
      }
    };
    fetchFlags();
  }, []);

  const handleToggle = async (key: string, value: boolean) => {
    const newFlags = { ...flags, [key]: value };
    setFlags(newFlags);
    try {
      await updateFeatureFlags(newFlags);
    } catch (err) {
      setError('Failed to save feature flags.');
    }
  };

  const handleAddFlag = () => {
    if (newFlagName.trim() && !flags.hasOwnProperty(newFlagName.trim())) {
      const newFlags = { ...flags, [newFlagName.trim()]: false };
      setFlags(newFlags);
      setNewFlagName('');
      updateFeatureFlags(newFlags);
    }
  };

  if (loading) return <div>Loading...</div>;
  if (error) return <div className="text-red-500">{error}</div>;

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold mb-4">Feature Flags</h2>
      <div className="space-y-4">
        {Object.keys(flags).map(key => (
          <div key={key} className="flex items-center justify-between p-2 border rounded">
            <span className="font-medium">{key}</span>
            <Switch.Root
              checked={flags[key]}
              onCheckedChange={(checked) => handleToggle(key, checked)}
              className="w-11 h-6 bg-gray-300 rounded-full relative data-[state=checked]:bg-green-500"
            >
              <Switch.Thumb className="block w-5 h-5 bg-white rounded-full transition-transform duration-100 transform data-[state=checked]:translate-x-5" />
            </Switch.Root>
          </div>
        ))}
      </div>
      <div className="mt-6">
        <h3 className="text-xl font-bold mb-2">Add New Flag</h3>
        <div className="flex items-center space-x-2">
          <input
            type="text"
            value={newFlagName}
            onChange={e => setNewFlagName(e.target.value)}
            placeholder="Flag name"
            className="border rounded px-2 py-1 flex-grow"
          />
          <button onClick={handleAddFlag} className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300">
            Add Flag
          </button>
        </div>
      </div>
    </div>
  );
}
