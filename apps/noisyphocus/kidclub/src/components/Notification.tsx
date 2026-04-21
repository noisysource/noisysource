import { XCircleIcon, CheckCircleIcon } from '@heroicons/react/24/solid';

interface NotificationProps {
  message: string;
  type: 'success' | 'error';
  onClose: () => void;
}

export default function Notification({ message, type, onClose }: NotificationProps) {
  const bgColor = type === 'success' ? 'bg-green-100' : 'bg-red-100';
  const textColor = type === 'success' ? 'text-green-800' : 'text-red-800';
  const Icon = type === 'success' ? CheckCircleIcon : XCircleIcon;

  return (
    <div className={`fixed top-5 right-5 p-4 rounded-md ${bgColor} ${textColor} flex items-center shadow-lg`}>
      <Icon className="h-6 w-6 mr-2" />
      <p>{message}</p>
      <button onClick={onClose} className="ml-4">
        <XCircleIcon className="h-6 w-6" />
      </button>
    </div>
  );
}
