import { useState, useEffect } from 'react';
import Calendar, { BookingSlot } from './Calendar';
import PartyBookingForm from './PartyBookingForm';
import { PartyConfig } from '@shared/models/PartyConfig';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';

export default function BookingPanel() {
  const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null);
  const [partyConfig, setPartyConfig] = useState<PartyConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const docRef = doc(db, 'config', 'party');
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data && Array.isArray(data.partyTypes) && Array.isArray(data.extras) && typeof data.pricePerExtraChild === 'number') {
          setPartyConfig(data as PartyConfig);
        } else {
          setError("A configuração de festas é inválida.");
        }
      } else {
        setError("Não foi possível carregar a configuração de festas.");
      }
    }, (err) => {
      setError("Ocorreu um erro ao carregar a configuração.");
    });

    return () => unsubscribe();
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 text-gray-800">
      <h2 className="text-3xl font-bold text-center text-purple-600 mb-8">Reserve a sua Festa!</h2>
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-10">
        <div>
          <Calendar onSelect={setSelectedSlot} />
        </div>
        <div>
          {selectedSlot ? (
            partyConfig ? (
              <PartyBookingForm
                partyConfig={partyConfig}
                initialData={{
                  id: '',
                  parentName: '',
                  childName: '',
                  childAge: 0,
                  partyType: partyConfig.partyTypes[0]?.name || '',
                  date: selectedSlot.date,
                  time: selectedSlot.time,
                  numKids: 10,
                  email: '',
                  phone: '',
                  status: 'pending',
                  createdAt: new Date(),
                  extras: [],
                  total: 0,
                }}
              />
            ) : (
              error ? <p className="text-red-500">{error}</p> : <p>A carregar configuração...</p>
            )
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-center text-gray-500">Selecione uma data e horário para continuar.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}