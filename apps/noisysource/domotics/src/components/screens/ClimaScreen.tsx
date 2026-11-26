import type { Device, HeatPumpCommand, ThermostatCommand } from '@shared/models/Device';
import type { FloorPlan } from '@shared/models/Room';
import type { AutomationStatus } from '../../data/automation';
import AutomationCard from '../AutomationCard';
import ClimatePanel from '../ClimatePanel';
import { FaultBanner } from '../HealthChips';

interface Props {
  plan: FloorPlan;
  devices: Device[];
  automation?: AutomationStatus;
  canEditAutomation: boolean;
  onThermostatCommand: (deviceId: string, command: ThermostatCommand) => void;
  onHeatPumpCommand: (deviceId: string, command: HeatPumpCommand) => void;
}

/** The heating automation (plan, timeline, settings) beside the thermostats and the pump. */
export default function ClimaScreen({ plan, devices, automation, canEditAutomation, onThermostatCommand, onHeatPumpCommand }: Props) {
  const pump = devices.find((d): d is Extract<Device, { type: 'heatpump' }> => d.type === 'heatpump' && d.online !== false);
  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 pt-4 pb-6 flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-zinc-50" style={{ paddingTop: 'env(safe-area-inset-top)' }}>Clima</h1>
      <FaultBanner devices={devices} />
      <div className="grid gap-5 lg:grid-cols-12 items-start">
        <div className="lg:col-span-7 min-w-0">
          <AutomationCard status={automation} canEdit={canEditAutomation} pumpOn={pump?.state.on} />
        </div>
        <div className="lg:col-span-5 min-w-0">
          <ClimatePanel devices={devices} rooms={plan.rooms} onThermostatCommand={onThermostatCommand} onHeatPumpCommand={onHeatPumpCommand} />
        </div>
      </div>
    </div>
  );
}
