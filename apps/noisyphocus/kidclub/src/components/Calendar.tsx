import { useState, useEffect, useMemo } from 'react';
import SidePanel from './SidePanel';
import { FinancialEvent } from '@shared/models';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';

export interface BookingSlot {
  date: string;
  time: string;
  status: 'pending' | 'confirmed' | 'rejected';
}

interface CalendarProps {
  summaryData?: { date: string; incomes: { [key: string]: number }; expenses: { [key: string]: number } }[];
  detailData?: { [key: string]: FinancialEvent[] };
  year?: number;
  month?: number;
  onSelect?: (slot: BookingSlot) => void;
}

interface Holiday {
  date: string;
  localName: string;
  name: string;
  countryCode: string;
  fixed: boolean;
  global: boolean;
  counties: string[] | null;
  launchYear: number | null;
  types: string[];
}

export default function Calendar({ summaryData, detailData, year: initialYear, month: initialMonth, onSelect }: CalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [bookings, setBookings] = useState<BookingSlot[]>([]);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [holidays, setHolidays] = useState<Holiday[]>([]);

  const year = initialYear !== undefined ? initialYear : currentDate.getFullYear();
  const month = initialMonth !== undefined ? initialMonth : currentDate.getMonth();

  const baseTimeSlots = ["10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00"]; // Example base time slots

  const timeToMinutes = (time: string | undefined): number => {
    if (!time) return Number.POSITIVE_INFINITY;
    const [hours, minutes] = time.split(':').map((value) => Number(value) || 0);
    return hours * 60 + minutes;
  };

  const compareTimes = (a: string, b: string) => timeToMinutes(a) - timeToMinutes(b);

  useEffect(() => {
    if (onSelect) {
      const fetchBookings = async () => {
        const bookingsCol = collection(db, 'bookings');
        const bookingsSnap = await getDocs(bookingsCol);
        const allBookings = bookingsSnap.docs.map(doc => doc.data() as BookingSlot);
        setBookings(allBookings);
        setIsLoading(false);
      };

      const fetchHolidays = async () => {
        try {
          const response = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/PT`);
          const data = await response.json();
          setHolidays(data);
        } catch (error) {
          console.error("Error fetching holidays:", error);
        }
      };

      fetchBookings();
      fetchHolidays();
    }
  }, [onSelect, year]);

  type DayBookingInfo = {
    bookings: BookingSlot[];
    confirmedCount: number;
  };

  const dayBookingInfo = useMemo(() => {
    const info = new Map<string, DayBookingInfo>();

    bookings.forEach((booking) => {
      if (!booking?.date) return;
      const { date, status } = booking;
      if (!info.has(date)) {
        info.set(date, {
          bookings: [],
          confirmedCount: 0,
        });
      }

      const dayInfo = info.get(date)!;
      dayInfo.bookings.push(booking);

      if (status === 'confirmed') {
        dayInfo.confirmedCount += 1;
      }
    });

    return info;
  }, [bookings]);

  const buildSlotCandidates = (bookingsOnDay: BookingSlot[]) => {
    const slots = new Set<string>(baseTimeSlots);
    bookingsOnDay.forEach((booking) => {
      if (booking?.time) {
        slots.add(booking.time);
      }
    });
    return Array.from(slots).sort(compareTimes);
  };

  const getDayMetrics = (day: Date) => {
    const dateStr = day.toISOString().split('T')[0];
    const info = dayBookingInfo.get(dateStr);
    const bookingsOnDay = info?.bookings ?? [];
    const confirmedCount = info?.confirmedCount ?? 0;

    const slotCandidates = buildSlotCandidates(bookingsOnDay);
    const blockedSlots = new Set<string>();

    bookingsOnDay.forEach((booking) => {
      const { time, status } = booking;
      if (!time) return;
      if (status !== 'confirmed' && status !== 'pending') return;

      const startMinutes = timeToMinutes(time);
      slotCandidates.forEach((slot) => {
        const slotMinutes = timeToMinutes(slot);
        if (slotMinutes >= startMinutes && slotMinutes < startMinutes + 120) {
          blockedSlots.add(slot);
        }
      });
    });

    const availableSlots = slotCandidates.filter((slot) => !blockedSlots.has(slot));

    return {
      bookingsOnDay,
      blockedSlots,
      confirmedCount,
      availableSlotsCount: availableSlots.length,
      totalSlots: slotCandidates.length,
      slotCandidates,
    };
  };

  const daysOfWeek = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const adjustedFirstDay = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;

  const summaryByDate = summaryData?.reduce((acc, item) => {
    acc[item.date] = item;
    return acc;
  }, {} as { [key: string]: { date: string; incomes: { [key: string]: number }; expenses: { [key: string]: number } } });

  const calendarDays: (Date | null)[] = Array.from({ length: adjustedFirstDay }, () => null).concat(
    Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1))
  );

  const handleDayClick = (day: Date | null) => {
    if (!day) return;

    if (onSelect) {
      setSelectedDay(day);
      setSelectedTime(null); // Reset time selection when a new day is clicked
    } else if (detailData && detailData[day.toISOString().split('T')[0]]) {
      setSelectedDay(day);
    }
  };

  const handleTimeSelect = (time: string) => {
    if (selectedDay && onSelect) {
      const selectedDate = selectedDay.toISOString().split('T')[0];
      const { blockedSlots } = getDayMetrics(selectedDay);
      if (!blockedSlots.has(time)) {
        onSelect({ date: selectedDate, time, status: 'pending' });
        setSelectedTime(time);
      }
    }
  };

  const isToday = (day: Date) => {
    const today = new Date();
    return day.getDate() === today.getDate() &&
      day.getMonth() === today.getMonth() &&
      day.getFullYear() === today.getFullYear();
  };

  const renderFinancialView = () => (
    <div className="grid grid-cols-7 gap-4 mt-2">
      {calendarDays.map((day, index) => (
        <div key={index} className={`p-2 rounded ${day ? 'bg-gray-100 cursor-pointer' : ''} ${day && isToday(day) ? 'bg-blue-200' : ''}`} onClick={() => handleDayClick(day)}>
          {day && (
            <div>
              <p className={`font-bold ${isToday(day) ? 'text-blue-800' : ''}`}>{day.getDate()}</p>
              {summaryByDate && summaryByDate[day.toISOString().split('T')[0]] && (
                <div className="bg-white p-2 mt-2 rounded shadow">
                  <div>
                    <h4 className="font-bold text-green-600">Receitas</h4>
                    {Object.entries(summaryByDate[day.toISOString().split('T')[0]].incomes).map(([category, total]) => (
                      <p key={category}><span className="font-bold">{category}:</span> €{total.toFixed(2)}</p>
                    ))}
                  </div>
                  <div className="mt-2">
                    <h4 className="font-bold text-red-600">Despesas</h4>
                    {Object.entries(summaryByDate[day.toISOString().split('T')[0]].expenses).map(([role, total]) => (
                      <p key={role}><span className="font-bold">{role}:</span> €{total.toFixed(2)}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );

  const renderBookingView = () => {
    if (isLoading) return <p>A carregar...</p>;

    const isHoliday = (day: Date) => {
      const dateStr = day.toISOString().split('T')[0];
      return holidays.some(h => h.date === dateStr && (h.counties === null || h.counties.includes('PT-06')));
    };

    const getDayAvailability = (day: Date) => {
      const dayOfWeek = day.getDay();
      const isWeekend = dayOfWeek === 6 || dayOfWeek === 0; // Saturday or Sunday

      if (!isWeekend && !isHoliday(day)) {
        return { available: false, slotsBooked: 0, totalSlots: 0 };
      }

      const { confirmedCount, availableSlotsCount, totalSlots } = getDayMetrics(day);

      return {
        available: availableSlotsCount > 0,
        slotsBooked: confirmedCount,
        totalSlots,
        availableSlots: availableSlotsCount,
      };
    };

    return (
      <>
        <div className="grid grid-cols-7 gap-4 mt-2">
          {calendarDays.map((day, index) => {
            if (!day) return <div key={index} className="p-4 rounded-lg bg-gray-50"></div>;

            const { available, slotsBooked, totalSlots, availableSlots } = getDayAvailability(day);
            const dayClass = available ? 'bg-green-200 hover:bg-green-300' : 'bg-red-200';

            return (
              <div key={index} className={`p-4 rounded-lg text-center cursor-pointer ${dayClass} ${selectedDay && selectedDay.toDateString() === day.toDateString() ? 'bg-blue-500 text-white' : ''}`} onClick={() => available && handleDayClick(day)}>
                <p>{day.getDate()}</p>
                {available && <p className="text-xs">({availableSlots}/{totalSlots}) livres</p>}
              </div>
            );
          })}
        </div>
        {selectedDay && (
          <div className="mt-4">
            <h3 className="text-lg font-semibold">Horários para {selectedDay.toLocaleDateString('pt-PT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}:</h3>
            <div className="flex flex-wrap gap-2 mt-2">
              {(() => {
                const { bookingsOnDay, blockedSlots, slotCandidates } = getDayMetrics(selectedDay);
                const dateKey = selectedDay.toISOString().split('T')[0];

                const blockingStatuses: Array<BookingSlot['status']> = ['pending', 'confirmed'];

                return slotCandidates.map((time) => {
                  const bookingForSlot = bookingsOnDay.find((slot) => slot.time === time);
                  const bookingStatus = bookingForSlot?.status;
                  const isBlockingStatus = bookingStatus ? blockingStatuses.includes(bookingStatus) : false;
                  const isBlocked = blockedSlots.has(time);

                  let buttonClass = 'bg-green-500 hover:bg-green-600 text-white';
                  let label = time;
                  let disabled = false;

                  if (bookingForSlot && isBlockingStatus) {
                    if (bookingStatus === 'confirmed') {
                      buttonClass = 'bg-gray-400 text-white cursor-not-allowed';
                      label = `${time} · Reservado`;
                      disabled = true;
                    } else if (bookingStatus === 'pending') {
                      buttonClass = 'bg-yellow-500 text-white cursor-not-allowed';
                      label = `${time} · Pendente`;
                      disabled = true;
                    }
                  } else if (isBlocked) {
                    buttonClass = 'bg-gray-200 text-gray-500 cursor-not-allowed';
                    label = `${time} · Indisponível`;
                    disabled = true;
                  }

                  return (
                    <button
                      key={`${dateKey}-${time}`}
                      onClick={() => !disabled && handleTimeSelect(time)}
                      disabled={disabled}
                      className={`px-4 py-2 rounded ${buttonClass} ${selectedTime === time && !disabled ? 'ring-2 ring-blue-500' : ''}`}
                    >
                      {label}
                    </button>
                  );
                });
              })()}
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <button onClick={() => setCurrentDate(new Date(year, month - 1, 1))} className="px-4 py-2 bg-gray-300 rounded">Anterior</button>
        <h2 className="text-xl font-bold">{new Date(year, month).toLocaleString('default', { month: 'long', year: 'numeric' })}</h2>
        <button onClick={() => setCurrentDate(new Date(year, month + 1, 1))} className="px-4 py-2 bg-gray-300 rounded">Próximo</button>
      </div>
      <div className="grid grid-cols-7 gap-4">
        {daysOfWeek.map(day => (
          <h3 key={day} className="font-bold text-center">{day}</h3>
        ))}
      </div>
      {onSelect ? renderBookingView() : renderFinancialView()}
      {selectedDay && detailData && <SidePanel date={selectedDay} entries={detailData[selectedDay.toISOString().split('T')[0]]} onClose={() => setSelectedDay(null)} />}
    </div>
  );
}