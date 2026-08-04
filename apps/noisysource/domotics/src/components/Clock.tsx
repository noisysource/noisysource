import { useState, useEffect } from 'react';

export default function Clock() {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const hh = time.getHours().toString().padStart(2, '0');
  const mm = time.getMinutes().toString().padStart(2, '0');
  const ss = time.getSeconds().toString().padStart(2, '0');

  return (
    <time
      dateTime={time.toISOString()}
      className="text-xl font-mono font-light tabular-nums text-zinc-400 tracking-widest select-none"
    >
      {hh}:{mm}
      <span className="text-zinc-600">:{ss}</span>
    </time>
  );
}
