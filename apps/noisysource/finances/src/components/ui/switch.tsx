import * as SwitchPrimitives from '@radix-ui/react-switch';
import { cn } from '../../lib/utils';


type Props = {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  disabled?: boolean;
};

export function Switch({ checked, onCheckedChange, disabled }: Props) {
  return (
    <SwitchPrimitives.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'peer inline-flex h-6 w-11 items-center rounded-full border-2 border-transparent transition-colors',
        checked ? 'bg-green-500' : 'bg-gray-300',
        'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <SwitchPrimitives.Thumb
        className={cn(
          'block h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ease-in-out',
          checked ? 'translate-x-5' : 'translate-x-0'
        )}
      />
    </SwitchPrimitives.Root>
  );
}