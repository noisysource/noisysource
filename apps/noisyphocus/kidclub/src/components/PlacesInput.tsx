import { useState, useRef, useEffect, useCallback } from 'react';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string;

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  required?: boolean;
  types?: string[]; // includedPrimaryTypes filter, e.g. ['school']
  nameOnly?: boolean; // use structuredFormat.mainText (place name) instead of full text
}

export default function PlacesInput({ value, onChange, placeholder, className, required, types, nameOnly }: Props) {
  const [suggestions, setSuggestions] = useState<{ id: string; label: string }[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const fetchSuggestions = useCallback(async (input: string) => {
    if (!input.trim() || !MAPS_KEY) { setSuggestions([]); setOpen(false); return; }
    try {
      const resp = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': MAPS_KEY,
          'X-Goog-FieldMask': '*',
        },
        body: JSON.stringify({
          input,
          includedRegionCodes: ['pt'],
          languageCode: 'pt',
          ...(types?.length ? { includedPrimaryTypes: types } : {}),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        console.error('[PlacesInput] API error:', data);
        setSuggestions([]); setOpen(false); return;
      }
      const list: any[] = data.suggestions ?? [];
      if (list.length) {
        setSuggestions(list.map(s => ({
          id: s.placePrediction.placeId,
          label: nameOnly
            ? (s.placePrediction.structuredFormat?.mainText?.text ?? s.placePrediction.text.text)
            : s.placePrediction.text.text,
        })));
        setOpen(true);
      } else {
        setSuggestions([]); setOpen(false);
      }
    } catch (e) {
      console.error('[PlacesInput] fetch error:', e);
      setSuggestions([]); setOpen(false);
    }
  }, []);

  const handleChange = (val: string) => {
    onChange(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(val), 300);
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={value}
        required={required}
        placeholder={placeholder}
        className={className}
        onChange={e => handleChange(e.target.value)}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-52 overflow-y-auto text-sm">
          {suggestions.map(s => (
            <li key={s.id}
              className="px-3 py-2 hover:bg-blue-50 cursor-pointer text-gray-700 leading-snug"
              onMouseDown={e => { e.preventDefault(); onChange(s.label); setSuggestions([]); setOpen(false); }}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
