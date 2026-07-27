import React, { useState, useEffect, useMemo } from 'react';
import { getTransportationConfig } from '../services/transportationService';
import { getFeatureFlags } from '../services/featureFlagsService';
import { addDoc, collection } from 'firebase/firestore';
import { db, analytics } from '../lib/firebase';
import { logEvent } from 'firebase/analytics';
import { TransportationConfig, TransportationSubscription, SubscriptionSchedule, Location } from '@shared/models/Transportation';
import { useUser } from '@shared/hooks';
import { LoadScript } from '@react-google-maps/api';
import { FormContext, FormContextProps, StableSubscriptionSchedule } from './transport/FormContext';
import { Step2 } from './transport/Step2';
import { Step3 } from './transport/Step3';
import { Step4 } from './transport/Step4';
import { Pricing } from './transport/Pricing';
import { Stepper } from './transport/Stepper';
import Notification from './Notification'; // Import Notification
import { trackClick } from '../lib/analytics';

// Legacy form data shape — old field names kept for backwards compatibility with Firestore documents
interface LegacyFormData {
  parentName: string;
  studentName: string;
  studentAge: number;
  contactMobile: string;
  contactEmail: string;
  startDate: string;
  [key: string]: any;
}

// --- MAIN COMPONENT ---

export default function TransportationSubscriptionForm({ isSimulation = false }: { isSimulation?: boolean }) {
  const user = useUser();
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState<LegacyFormData>({
    parentName: user?.name || '',
    studentName: '',
    studentAge: 0,
    contactMobile: '',
    contactEmail: user?.email || '',
    startDate: new Date().toISOString().split('T')[0],
  });
  const [schedule, setSchedule] = useState<Partial<StableSubscriptionSchedule>[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transportationConfig, setTransportationConfig] = useState<TransportationConfig | null>(null);
  const [featureFlags, setFeatureFlags] = useState<any>({});
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [subtotal, setSubtotal] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // State for Step3 moved here
  const [mainPickup, setMainPickup] = useState<Location | null>(null);
  const [mainDropoff, setMainDropoff] = useState<Location | null>(null);
  const [tripDays, setTripDays] = useState<string[]>([]);
  const [tripTime, setTripTime] = useState('08:00');
  const [tripIdCounter, setTripIdCounter] = useState(0);

  const showNotification = (message: string, type: 'success' | 'error') => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(null);
    }, 3000);
  };

  const calculatePrice = (currentSchedule: Partial<StableSubscriptionSchedule>[]) => {
    if (!transportationConfig) return;

    let weeklyPrice = 0;
    let totalDiscount = 0;
    const tripsByDay: { [key: string]: number } = {};

    for (const trip of currentSchedule) {
      if (trip.dayOfWeek) {
        if (!tripsByDay[trip.dayOfWeek]) {
          tripsByDay[trip.dayOfWeek] = 0;
        }
        tripsByDay[trip.dayOfWeek]++;
      }
    }

    for (const day in tripsByDay) {
      const numTrips = tripsByDay[day];
      const pricePerTrip = transportationConfig.flatRatePerTrip || 0;
      let dayPrice = numTrips * pricePerTrip;

      if (numTrips >= (transportationConfig.minTripsForDiscount || 2)) {
        const discountAmount = dayPrice * (transportationConfig.multiTripDiscountPercentage || 0);
        totalDiscount += discountAmount;
      }
      weeklyPrice += dayPrice;
    }

    setSubtotal(weeklyPrice * 4);
    setDiscount(totalDiscount * 4);
  };

  const handleAddTrips = () => {
    trackClick('add_trip_click');
    if (!mainPickup || !mainDropoff || tripDays.length === 0) {
      showNotification("Por favor, defina os locais de partida/destino e selecione pelo menos um dia e uma hora.", 'error');
      return;
    }

    // Validation for duplicate trips
    for (const day of tripDays) {
      const isDuplicate = schedule.some(trip => 
        trip.dayOfWeek === day && 
        trip.pickupTime === tripTime && 
        trip.pickupLocation === mainPickup.address &&
        trip.dropoffLocation === mainDropoff.address
      );

      if (isDuplicate) {
        showNotification(`A viagem para ${day} às ${tripTime} já foi adicionada.`, 'error');
        return;
      }
    }

    const newTrips: Partial<StableSubscriptionSchedule>[] = tripDays.map((day, index) => ({
        id: `trip_${tripIdCounter + index}`,
        dayOfWeek: day as SubscriptionSchedule['dayOfWeek'],
        pickupTime: tripTime,
        pickupLocation: mainPickup?.address ?? '',
        dropoffLocation: mainDropoff?.address ?? '',
    }));

    setTripIdCounter(prev => prev + tripDays.length);
    const newSchedule: Partial<StableSubscriptionSchedule>[] = [...schedule, ...newTrips];
    setSchedule(newSchedule);
    calculatePrice(newSchedule);
    setTripDays([]); // Reset for next entry
  }

  const removeScheduleItem = (id: string) => {
    const newSchedule = schedule.filter(trip => trip.id !== id);
    setSchedule(newSchedule);
    calculatePrice(newSchedule);
  }

  const nextStep = () => setStep(prev => prev + 1);
  const prevStep = () => setStep(prev => prev - 1);

  useEffect(() => {
    const fetchConfigs = async () => {
      try {
        const transportConfig = await getTransportationConfig();
        if (transportConfig) {
          setTransportationConfig(transportConfig);
        } else {
          setConfigError("Configuração de transporte não encontrada.");
        }

        const flags = await getFeatureFlags();
        setFeatureFlags(flags);

      } catch (err) {
        console.error("Error fetching config:", err);
        setConfigError("Erro ao carregar a configuração.");
      } finally {
        setConfigLoading(false);
      }
    };
    fetchConfigs();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'number' ? parseFloat(value) || 0 : value }));
  };

  const handleLocationChange = (name: string, location: Location) => {
    setFormData(prev => ({ ...prev, [name]: location }));
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setLoading(true);
    setError(null);

    try {
      const { parentName, studentName, studentAge, contactMobile, contactEmail, startDate } = formData;
      if (!parentName || !studentName || !studentAge || !contactMobile || !contactEmail || !startDate || schedule.length === 0) {
        setError("Por favor, preencha os seus dados e adicione pelo menos uma viagem à sua subscrição.");
        setLoading(false);
        return;
      }
      const finalSchedule = schedule.map(({ id, ...rest }) => rest) as SubscriptionSchedule[];
      // Written with legacy fields for backwards compat — admin panel reads these
      const newSubscription = {
        userId: user?.uid || 'guest',
        parentName, studentName, studentAge, contactMobile, contactEmail, startDate,
        familyId: '',
        childId: '',
        childName: studentName,
        childAge: Number(studentAge),
        schedule: finalSchedule,
        status: 'pending' as const,
        monthlyFee: subtotal,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await addDoc(collection(db, 'transportationSubscriptions'), newSubscription as any);
      (logEvent as any)(analytics, 'purchase', {
        currency: 'EUR',
        value: subtotal,
        items: finalSchedule.map(item => ({
          item_id: item.dayOfWeek,
          item_name: `Transport subscription - ${item.dayOfWeek}`,
          price: transportationConfig?.flatRatePerTrip || 0,
          quantity: 1,
        })),
      } as any);
      setSubmitted(true);
    } catch (err) {
      console.error("Error submitting request:", err);
      setError("Ocorreu um erro ao enviar sua solicitação. Por favor, tente novamente.");
    } finally {
      setLoading(false);
    }
  };

  const formState: FormContextProps = {
    formData: formData as Partial<TransportationSubscription>,
    handleChange,
    handleLocationChange,
    schedule, setSchedule,
    transportationConfig,
    subtotal,
    discount,
    featureFlags,
    calculatePrice,
  };

  if (configLoading) return <div className="text-center p-10">A carregar configuração...</div>;
  if (configError) return <div className="text-center p-10 text-red-600 bg-red-50 rounded-lg">{configError}</div>;
  if (submitted) return (
    <div className="text-center p-10 max-w-lg mx-auto">
      <div className="bg-green-100 text-green-800 p-8 rounded-xl shadow-lg">
        <h2 className="text-2xl font-bold mb-2">✅ Pedido Enviado com Sucesso!</h2>
        <p>Obrigado! A nossa equipa entrará em contacto em breve para confirmar todos os detalhes.</p>
      </div>
    </div>
  );

  return (
    <LoadScript googleMapsApiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY} libraries={["places"]}>
        <FormContext.Provider value={formState}>
        <div className="bg-gray-50 min-h-screen p-4 sm:p-8">
            <div className="max-w-5xl mx-auto">
            <div className="text-center mb-8">
                <h1 className="text-4xl font-extrabold text-purple-600 tracking-tight">Solicitar Transporte</h1>
                <p className="mt-2 text-lg text-gray-600">Fácil, rápido e seguro. Em apenas 3 passos.</p>
            </div>

            {error && <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-6 rounded-md shadow-sm" role="alert"><p>{error}</p></div>}

            <Stepper currentStep={step} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2">
                <form onSubmit={handleSubmit}>
                    {step === 1 && <Step2 nextStep={nextStep} prevStep={prevStep} />}
                    {step === 2 && <Step3 nextStep={nextStep} prevStep={prevStep} mainPickup={mainPickup} setMainPickup={setMainPickup} mainDropoff={mainDropoff} setMainDropoff={setMainDropoff} tripDays={tripDays} setTripDays={setTripDays} tripTime={tripTime} setTripTime={setTripTime} handleAddTrips={handleAddTrips} removeScheduleItem={removeScheduleItem} />}
                    {step === 3 && <Step4 prevStep={prevStep} loading={loading} handleSubmit={() => handleSubmit({} as React.FormEvent)} isSimulation={isSimulation} isLoggedIn={!!user} />}
                </form>
                </div>
                <div className="lg:col-span-1">
                <Pricing />
                </div>
            </div>
            </div>
        </div>
        </FormContext.Provider>
      {notification && (
        <Notification 
          message={notification.message} 
          type={notification.type} 
          onClose={() => setNotification(null)} 
        />
      )}
    </LoadScript>
  );
}
