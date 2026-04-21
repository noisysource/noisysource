import React, { ReactNode } from 'react';

export const Card = ({ children, className = '' }: { children: ReactNode, className?: string }) => (
  <div className={`bg-white p-6 rounded-lg shadow-md ${className}`}>
    {children}
  </div>
);

export const Button = ({ children, onClick, variant = 'primary', disabled = false, type = 'button' }: { children: ReactNode, onClick?: () => void, variant?: 'primary' | 'secondary' | 'danger' | 'ghost', disabled?: boolean, type?: 'button' | 'submit' }) => {
  const baseClasses = 'px-4 py-2 rounded-md font-semibold flex items-center justify-center gap-2 transition-colors';
  const variantClasses = {
    primary: 'bg-purple-600 text-white hover:bg-purple-700 disabled:bg-purple-300',
    secondary: 'bg-gray-200 text-gray-800 hover:bg-gray-300 disabled:bg-gray-100',
    danger: 'bg-red-500 text-white hover:bg-red-600',
    ghost: 'bg-transparent text-gray-600 hover:bg-gray-100',
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${baseClasses} ${variantClasses[variant]}`}>
      {children}
    </button>
  );
};

export const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm" />
);

export const Label = ({ children }: { children: ReactNode }) => (
  <label className="block text-sm font-medium text-gray-700">{children}</label>
);
