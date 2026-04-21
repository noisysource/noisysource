
import { useState } from 'react';
import { ChevronDownIcon } from '@heroicons/react/24/solid';

interface SidebarSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

export default function SidebarSection({ title, children, defaultOpen = false }: SidebarSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex justify-between items-center px-3 py-2 text-left text-md font-bold text-pink-600 hover:bg-pink-50 rounded"
      >
        <span>{title}</span>
        <ChevronDownIcon
          className={`w-5 h-5 transform transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>
      {isOpen && <div className="pl-4 mt-2 space-y-2">{children}</div>}
    </div>
  );
}
