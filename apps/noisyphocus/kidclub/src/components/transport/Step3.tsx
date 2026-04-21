import React, { useMemo } from 'react';
import { useFormContext, StableSubscriptionSchedule } from './FormContext';
import { Card, Button, Input, Label } from './common';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { Autocomplete } from '@react-google-maps/api';
import { Location } from '@shared/models/Transportation';
import { trackClick } from '../../lib/analytics';

const WEEKDAYS = [
  { label: "Segunda", value: "monday" },
  { label: "Terça", value: "tuesday" },
  { label: "Quarta", value: "wednesday" },
  { label: "Quinta", value: "thursday" },
  { label: "Sexta", value: "friday" },
];

export const Step3 = ({ nextStep, prevStep, mainPickup, setMainPickup, mainDropoff, setMainDropoff, tripDays, setTripDays, tripTime, setTripTime, handleAddTrips, removeScheduleItem }) => {
  const { requestType, formData, handleLocationChange, schedule, handleChange } = useFormContext();
  const autocompleteRefs = React.useRef<{[key: string]: google.maps.places.Autocomplete}>({});
  
  const onPlaceChanged = (locationSetter: (loc: Location) => void, autocompleteKey: string) => {
      const autocomplete = autocompleteRefs.current[autocompleteKey];
      if (autocomplete) {
        const place = autocomplete.getPlace();
        if (!place || !place.geometry || !place.geometry.location) return;
        const location: Location = {
            address: place.formatted_address || '',
            lat: place.geometry.location.lat() || 0,
            lng: place.geometry.location.lng() || 0
        }
        locationSetter(location);
      } 
  }

  const handleDayToggle = (day: string) => {
    setTripDays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]);
  }

  const groupedSchedule = useMemo(() => {
    return schedule.reduce<Record<string, Partial<StableSubscriptionSchedule>[]>>((acc, trip) => {
      const day = trip.dayOfWeek!;
      if (!acc[day]) acc[day] = [];
      acc[day].push(trip);
      return acc;
    }, {});
  }, [schedule]);

  return (
    <Card>
      <h3 className="text-xl font-semibold mb-6 text-center">Detalhes da Viagem</h3>
      {requestType === 'one-time' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
                <Label>Local de Partida</Label>
                <Autocomplete
                    onLoad={(ac) => autocompleteRefs.current['onetime_pickup'] = ac}
                    onPlaceChanged={() => onPlaceChanged((loc) => handleLocationChange('pickupLocation', loc), 'onetime_pickup')}
                >
                    <Input type="text" name="pickupLocation" required />
                </Autocomplete>
            </div>
            <div>
                <Label>Local de Destino</Label>
                <Autocomplete
                    onLoad={(ac) => autocompleteRefs.current['onetime_dropoff'] = ac}
                    onPlaceChanged={() => onPlaceChanged((loc) => handleLocationChange('dropoffLocation', loc), 'onetime_dropoff')}
                >
                    <Input type="text" name="dropoffLocation" required />
                </Autocomplete>
            </div>
            <div><Label>Data</Label><Input type="date" name="requestDate" value={formData.requestDate || ''} onChange={handleChange} required /></div>
            <div><Label>Hora</Label><Input type="time" name="requestTime" value={formData.requestTime || ''} onChange={handleChange} required /></div>
          </div>
          <div><Label>Número de Passageiros</Label><Input type="number" name="numberOfPassengers" value={formData.numberOfPassengers || 1} onChange={handleChange} min="1" /></div>
          <div><Label>Notas Especiais (opcional)</Label><textarea name="specialNotes" value={formData.specialNotes || ''} onChange={handleChange} rows={3} className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"></textarea></div>
        </div>
      ) : (
        <div className="space-y-6">
          <div>
            <Label>Data de Início da Subscrição</Label>
            <Input type="date" name="startDate" value={formData.startDate || ''} onChange={handleChange} required />
          </div>

          <div className="rounded-lg border border-gray-200 p-4 space-y-4">
            <h4 className="text-lg font-medium text-gray-900">1. Definir Locais Principais</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <Label>Local de Partida Principal</Label>
                    <Autocomplete onLoad={(ac) => autocompleteRefs.current['main_pickup'] = ac} onPlaceChanged={() => onPlaceChanged(setMainPickup, 'main_pickup')}>
                        <Input type="text" placeholder="Ex: Casa" required />
                    </Autocomplete>
                </div>
                <div>
                    <Label>Local de Destino Principal</Label>
                    <Autocomplete onLoad={(ac) => autocompleteRefs.current['main_dropoff'] = ac} onPlaceChanged={() => onPlaceChanged(setMainDropoff, 'main_dropoff')}>
                        <Input type="text" placeholder="Ex: Escola" required />
                    </Autocomplete>
                </div>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 p-4 space-y-4">
            <h4 className="text-lg font-medium text-gray-900">2. Adicionar Viagens à Agenda</h4>
            <div>
                <Label>Selecione os dias da semana</Label>
                <div className="flex flex-wrap gap-2 mt-2">
                    {WEEKDAYS.map(day => (
                        <button key={day.value} type="button" onClick={() => handleDayToggle(day.value)} className={`px-3 py-1.5 text-sm rounded-full transition-colors ${tripDays.includes(day.value) ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}>
                            {day.label}
                        </button>
                    ))}
                </div>
            </div>
            <div>
                <Label>Hora da Partida</Label>
                <Input type="time" value={tripTime} onChange={e => setTripTime(e.target.value)} />
            </div>
            <Button onClick={handleAddTrips} variant="secondary" disabled={!mainPickup || !mainDropoff || tripDays.length === 0}><Plus size={16}/> Adicionar Viagens</Button>
          </div>

          <div className="rounded-lg border border-gray-200 p-4">
            <h4 className="text-lg font-medium text-gray-900 mb-4">3. Agenda Resultante</h4>
            {schedule.length === 0 ? (
                <p className="text-sm text-gray-500">A sua agenda de viagens aparecerá aqui.</p>
            ) : (
                <div className="space-y-3">
                    {Object.keys(groupedSchedule).map(day => (
                        <div key={day}>
                            <h5 className="text-md font-semibold capitalize text-purple-700 mt-2">{day}</h5>
                            <ul className="mt-1 space-y-1 list-disc list-inside pl-2">
                                {groupedSchedule[day].map(trip => (
                                    <li key={trip.id} className="text-sm text-gray-800 flex items-center justify-between">
                                        <span>{trip.pickupTime} de <strong>{trip.pickupLocation?.address}</strong> para <strong>{trip.dropoffLocation?.address}</strong></span>
                                        <Button onClick={() => removeScheduleItem(trip.id!)} variant='ghost'><X size={16} className="text-red-500"/></Button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            )}
          </div>
        </div>
      )}
      <div className="flex justify-between mt-8">
        <Button onClick={() => { trackClick('step3_prev_click'); prevStep(); }} variant="secondary"><ChevronLeft size={18} /> Anterior</Button>
        <Button onClick={() => { trackClick('step3_next_click'); nextStep(); }}>Próximo <ChevronRight size={18} /></Button>
      </div>
    </Card>
  );
};
