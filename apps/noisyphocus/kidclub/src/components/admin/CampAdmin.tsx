import { useState, useEffect } from 'react';
import { campService } from '../../services/campService';
import { CampDay, CampBooking } from '@shared/models/Camp';
import { format, parseISO, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, getDay, startOfWeek, endOfWeek } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { db } from '../../lib/firebase';
import { collection, getDocs } from 'firebase/firestore';

export default function CampAdminPanel() {
    const [section, setSection] = useState<'days' | 'bookings' | 'daily'>('bookings');
    const [dailyViewMode, setDailyViewMode] = useState<'table' | 'calendar' | 'attendees'>('calendar');
    const [campDays, setCampDays] = useState<CampDay[]>([]);
    const [bookings, setBookings] = useState<CampBooking[]>([]);
    const [studyRoomChildIds, setStudyRoomChildIds] = useState<Set<string>>(new Set());
    const [isLoading, setIsLoading] = useState(true);
    const [editingDay, setEditingDay] = useState<CampDay | null>(null);
    const [showDayForm, setShowDayForm] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);

    useEffect(() => {
        loadData();
    }, [section]);

    const loadData = async () => {
        setIsLoading(true);
        try {
            // Load study room subscriptions to identify study room kids
            const studyRoomSnapshot = await getDocs(collection(db, 'studyroom'));
            const studyRoomIds = new Set<string>();
            studyRoomSnapshot.docs.forEach(doc => {
                const data = doc.data();
                if (data.childId) {
                    studyRoomIds.add(data.childId);
                }
            });
            setStudyRoomChildIds(studyRoomIds);

            if (section === 'days') {
                const days = await campService.getCampDays();
                setCampDays(days);
            } else if (section === 'daily') {
                const days = await campService.getCampDays();
                const bookingList = await campService.getBookings();
                setCampDays(days);
                setBookings(bookingList);
            } else {
                const bookingList = await campService.getBookings();
                setBookings(bookingList);
            }
        } catch (error) {
            console.error('Error loading data:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSaveDay = async (day: Omit<CampDay, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => {
        try {
            setError(null);
            setSuccessMessage(null);
            await campService.saveCampDay(day);
            setSuccessMessage(day.id ? 'Dia atualizado com sucesso!' : 'Dia criado com sucesso!');
            setShowDayForm(false);
            setEditingDay(null);
            setTimeout(() => {
                setSuccessMessage(null);
                loadData();
            }, 1000);
        } catch (error: any) {
            console.error('Error saving day:', error);
            setError(error?.message || 'Erro ao guardar dia. Por favor, verifique os dados e tente novamente.');
        }
    };

    const handleUpdateBookingStatus = async (id: string, status: 'pending' | 'confirmed' | 'cancelled', reason?: string) => {
        try {
            setError(null);
            await campService.updateBookingStatus(id, status, reason);
            await loadData();
        } catch (error: any) {
            console.error('Error updating booking status:', error);
            setError(error?.message || 'Erro ao atualizar estado da inscrição.');
        }
    };

    const getBookingStats = () => {
        const stats = {
            total: bookings.length,
            pending: bookings.filter((b) => b.status === 'pending').length,
            confirmed: bookings.filter((b) => b.status === 'confirmed').length,
            cancelled: bookings.filter((b) => b.status === 'cancelled').length,
            totalRevenue: bookings.filter((b) => b.status === 'confirmed').reduce((sum, b) => sum + b.totalPrice, 0),
        };
        return stats;
    };

    const getDailyStats = () => {
        const dailyStats = campDays.map((day) => {
            const confirmedKids = bookings.filter(
                (b) => b.status === 'confirmed' && b.selectedDays.includes(day.id)
            ).length;
            const pendingKids = bookings.filter(
                (b) => b.status === 'pending' && b.selectedDays.includes(day.id)
            ).length;
            const totalKids = confirmedKids + pendingKids;
            const remainingSpots = Math.max(0, day.capacity - totalKids);

            return {
                day,
                confirmedKids,
                pendingKids,
                totalKids,
                capacity: day.capacity,
                remainingSpots,
            };
        });

        return dailyStats.sort((a, b) => a.day.date.localeCompare(b.day.date));
    };

    const getAttendeesPerDay = () => {
        return campDays.map((day) => {
            const confirmedBookings = bookings.filter(
                (b) => b.status === 'confirmed' && b.selectedDays.includes(day.id)
            );
            const pendingBookings = bookings.filter(
                (b) => b.status === 'pending' && b.selectedDays.includes(day.id)
            );

            // Group confirmed bookings by email
            const confirmedByEmail = new Map<string, typeof confirmedBookings>();
            confirmedBookings.forEach(booking => {
                const email = booking.email.toLowerCase();
                if (!confirmedByEmail.has(email)) {
                    confirmedByEmail.set(email, []);
                }
                confirmedByEmail.get(email)!.push(booking);
            });

            // Group pending bookings by email
            const pendingByEmail = new Map<string, typeof pendingBookings>();
            pendingBookings.forEach(booking => {
                const email = booking.email.toLowerCase();
                if (!pendingByEmail.has(email)) {
                    pendingByEmail.set(email, []);
                }
                pendingByEmail.get(email)!.push(booking);
            });

            return {
                day,
                confirmedGroups: Array.from(confirmedByEmail.entries()).map(([email, groupBookings]) => {
                    const firstBooking = groupBookings[0];
                    const children = groupBookings.map(b => ({
                        childName: b.childName,
                        childAge: b.childAge,
                        bookingId: b.id,
                        isStudyRoom: b.childId ? studyRoomChildIds.has(b.childId) : false,
                    }));

                    return {
                        email: firstBooking.email,
                        parentName: firstBooking.parentName,
                        phone: firstBooking.phone,
                        children,
                        count: groupBookings.length,
                    };
                }),
                pendingGroups: Array.from(pendingByEmail.entries()).map(([email, groupBookings]) => {
                    const firstBooking = groupBookings[0];
                    const children = groupBookings.map(b => ({
                        childName: b.childName,
                        childAge: b.childAge,
                        bookingId: b.id,
                        isStudyRoom: b.childId ? studyRoomChildIds.has(b.childId) : false,
                    }));

                    return {
                        email: firstBooking.email,
                        parentName: firstBooking.parentName,
                        phone: firstBooking.phone,
                        children,
                        count: groupBookings.length,
                    };
                }),
            };
        }).sort((a, b) => a.day.date.localeCompare(b.day.date));
    };

    const stats = getBookingStats();
    const dailyStats = getDailyStats();

    return (
        <div className="p-6">
            {error && (
                <div className="mb-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative">
                    <span className="block sm:inline">{error}</span>
                    <button
                        onClick={() => setError(null)}
                        className="absolute top-0 bottom-0 right-0 px-4 py-3"
                    >
                        <span className="text-red-700">×</span>
                    </button>
                </div>
            )}
            {successMessage && (
                <div className="mb-4 bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded">
                    {successMessage}
                </div>
            )}
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-3xl font-bold text-pink-600">🎄 Gestão Actividades de natal 2025</h1>
                <div className="flex gap-2">
                    <button
                        onClick={() => setSection('bookings')}
                        className={`px-4 py-2 rounded ${section === 'bookings' ? 'bg-pink-600 text-white' : 'bg-gray-200'}`}
                    >
                        Inscrições ({stats.total})
                    </button>
                    <button
                        onClick={() => setSection('daily')}
                        className={`px-4 py-2 rounded ${section === 'daily' ? 'bg-pink-600 text-white' : 'bg-gray-200'}`}
                    >
                        Vista por Dia
                    </button>
                    <button
                        onClick={() => setSection('days')}
                        className={`px-4 py-2 rounded ${section === 'days' ? 'bg-pink-600 text-white' : 'bg-gray-200'}`}
                    >
                        Dias do Campo ({campDays.length})
                    </button>
                </div>
            </div>

            {section === 'daily' && (
                <div>
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="text-2xl font-semibold">Vista por Dia - Crianças Inscritas</h2>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setDailyViewMode('calendar')}
                                className={`px-4 py-2 rounded ${dailyViewMode === 'calendar' ? 'bg-pink-600 text-white' : 'bg-gray-200'}`}
                            >
                                📅 Calendário
                            </button>
                            <button
                                onClick={() => setDailyViewMode('table')}
                                className={`px-4 py-2 rounded ${dailyViewMode === 'table' ? 'bg-pink-600 text-white' : 'bg-gray-200'}`}
                            >
                                📊 Tabela
                            </button>
                            <button
                                onClick={() => setDailyViewMode('attendees')}
                                className={`px-4 py-2 rounded ${dailyViewMode === 'attendees' ? 'bg-pink-600 text-white' : 'bg-gray-200'}`}
                            >
                                👥 Participantes
                            </button>
                        </div>
                    </div>
                    {isLoading ? (
                        <div className="text-center p-6">A carregar...</div>
                    ) : dailyViewMode === 'calendar' ? (
                        <CampCalendarView dailyStats={dailyStats} />
                    ) : dailyViewMode === 'attendees' ? (
                        <CampAttendeesView attendeesPerDay={getAttendeesPerDay()} />
                    ) : (
                        <div className="bg-white rounded-lg shadow-md overflow-hidden">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                    <tr>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Dia</th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Data</th>
                                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Confirmadas</th>
                                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Pendentes</th>
                                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Total</th>
                                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Capacidade</th>
                                        <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Vagas Restantes</th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                    {dailyStats.map((stat) => (
                                        <tr key={stat.day.id} className={stat.remainingSpots === 0 ? 'bg-red-50' : stat.remainingSpots <= 3 ? 'bg-yellow-50' : ''}>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm font-medium text-gray-900">{stat.day.name}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                                {stat.day.date ? (() => {
                                                    try {
                                                        return format(parseISO(stat.day.date), "d 'de' MMMM yyyy", { locale: ptBR });
                                                    } catch {
                                                        return stat.day.date;
                                                    }
                                                })() : 'Data não definida'}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-center">
                                                <span className="text-sm font-semibold text-green-600">{stat.confirmedKids}</span>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-center">
                                                <span className="text-sm font-semibold text-yellow-600">{stat.pendingKids}</span>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-center">
                                                <span className="text-sm font-bold text-gray-900">{stat.totalKids}</span>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-center">
                                                <span className="text-sm text-gray-600">{stat.capacity}</span>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-center">
                                                <span className={`text-sm font-semibold ${stat.remainingSpots === 0 ? 'text-red-600' : stat.remainingSpots <= 3 ? 'text-yellow-600' : 'text-green-600'}`}>
                                                    {stat.remainingSpots}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {section === 'bookings' && (
                <div>
                    {/* Stats */}
                    <div className="grid grid-cols-4 gap-4 mb-6">
                        <div className="bg-blue-50 p-4 rounded-lg">
                            <div className="text-sm text-gray-600">Total</div>
                            <div className="text-2xl font-bold">{stats.total}</div>
                        </div>
                        <div className="bg-yellow-50 p-4 rounded-lg">
                            <div className="text-sm text-gray-600">Pendentes</div>
                            <div className="text-2xl font-bold">{stats.pending}</div>
                        </div>
                        <div className="bg-green-50 p-4 rounded-lg">
                            <div className="text-sm text-gray-600">Confirmadas</div>
                            <div className="text-2xl font-bold">{stats.confirmed}</div>
                        </div>
                        <div className="bg-pink-50 p-4 rounded-lg">
                            <div className="text-sm text-gray-600">Receita</div>
                            <div className="text-2xl font-bold">€{stats.totalRevenue.toFixed(2)}</div>
                        </div>
                    </div>

                    {/* Bookings List */}
                    {isLoading ? (
                        <div className="text-center p-6">A carregar...</div>
                    ) : (
                        <div className="bg-white rounded-lg shadow-md overflow-hidden">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                    <tr>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Criança</th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Encarregado</th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Contacto</th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Dias</th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total</th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Estado</th>
                                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ações</th>
                                    </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                    {bookings.map((booking) => (
                                        <tr key={booking.id}>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <div className="text-sm font-medium text-gray-900">{booking.childName}</div>
                                                <div className="text-sm text-gray-500">Idade: {booking.childAge}</div>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{booking.parentName}</td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                                <div>{booking.email}</div>
                                                <div>{booking.phone}</div>
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-500">
                                                {booking.selectedDays.length} dia{booking.selectedDays.length !== 1 ? 's' : ''}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                                €{booking.totalPrice.toFixed(2)}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                <span
                                                    className={`px-2 py-1 text-xs font-semibold rounded-full ${booking.status === 'confirmed'
                                                        ? 'bg-green-100 text-green-800'
                                                        : booking.status === 'cancelled'
                                                            ? 'bg-red-100 text-red-800'
                                                            : 'bg-yellow-100 text-yellow-800'
                                                        }`}
                                                >
                                                    {booking.status === 'confirmed' ? 'Confirmada' : booking.status === 'cancelled' ? 'Cancelada' : 'Pendente'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                                                <div className="flex gap-2">
                                                    {booking.status === 'pending' && (
                                                        <>
                                                            <button
                                                                onClick={() => handleUpdateBookingStatus(booking.id, 'confirmed')}
                                                                className="text-green-600 hover:text-green-900"
                                                            >
                                                                Confirmar
                                                            </button>
                                                            <button
                                                                onClick={() => {
                                                                    const reason = prompt('Razão do cancelamento:');
                                                                    if (reason) handleUpdateBookingStatus(booking.id, 'cancelled', reason);
                                                                }}
                                                                className="text-red-600 hover:text-red-900"
                                                            >
                                                                Cancelar
                                                            </button>
                                                        </>
                                                    )}
                                                    {booking.status === 'confirmed' && (
                                                        <button
                                                            onClick={() => {
                                                                const reason = prompt('Razão do cancelamento:');
                                                                if (reason) handleUpdateBookingStatus(booking.id, 'cancelled', reason);
                                                            }}
                                                            className="text-red-600 hover:text-red-900"
                                                        >
                                                            Cancelar
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {section === 'days' && (
                <div>
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="text-2xl font-semibold">Dias do Campo</h2>
                        <button
                            onClick={() => {
                                setEditingDay(null);
                                setShowDayForm(true);
                            }}
                            className="bg-pink-600 text-white px-4 py-2 rounded hover:bg-pink-700"
                        >
                            + Adicionar Dia
                        </button>
                    </div>

                    {showDayForm && (
                        <CampDayForm
                            day={editingDay}
                            onSave={handleSaveDay}
                            onCancel={() => {
                                setShowDayForm(false);
                                setEditingDay(null);
                            }}
                        />
                    )}

                    {isLoading ? (
                        <div className="text-center p-6">A carregar...</div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {campDays.map((day) => (
                                <div key={day.id} className="bg-white rounded-lg shadow-md p-4">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="text-lg font-semibold">{day.name}</h3>
                                        <span className={`px-2 py-1 text-xs rounded ${day.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                                            {day.active ? 'Ativo' : 'Inativo'}
                                        </span>
                                    </div>
                                    <div className="text-sm text-gray-600 mb-2">
                                        {day.date ? (() => {
                                            try {
                                                return format(parseISO(day.date), "d 'de' MMMM", { locale: ptBR });
                                            } catch {
                                                return day.date;
                                            }
                                        })() : 'Data não definida'}
                                    </div>
                                    <div className="text-sm mb-2">
                                        <div><strong>Manhã:</strong> {day.morning}</div>
                                        <div><strong>Almoço:</strong> {day.lunch}</div>
                                        <div><strong>Tarde:</strong> {day.afternoon}</div>
                                    </div>
                                    <div className="flex justify-between items-center mt-4">
                                        <div>
                                            <div className="text-sm text-gray-600">Capacidade: {day.capacity}</div>
                                            <div className="text-lg font-bold text-pink-600">€{day.price.toFixed(2)}</div>
                                        </div>
                                        <button
                                            onClick={() => {
                                                setEditingDay(day);
                                                setShowDayForm(true);
                                            }}
                                            className="text-blue-600 hover:text-blue-800 text-sm"
                                        >
                                            Editar
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function CampAttendeesView({ attendeesPerDay }: { attendeesPerDay: Array<{ day: CampDay; confirmedGroups: Array<{ email: string; parentName: string; phone: string; children: Array<{ childName: string; childAge: number; bookingId: string; isStudyRoom: boolean }>; count: number }>; pendingGroups: Array<{ email: string; parentName: string; phone: string; children: Array<{ childName: string; childAge: number; bookingId: string; isStudyRoom: boolean }>; count: number }> }> }) {
    if (attendeesPerDay.length === 0) {
        return <div className="text-center p-6 text-gray-500">Nenhum dia de campo configurado.</div>;
    }

    return (
        <div className="space-y-4">
            {attendeesPerDay.map(({ day, confirmedGroups, pendingGroups }) => {
                const totalAttendees = confirmedGroups.reduce((sum, g) => sum + g.count, 0) +
                    pendingGroups.reduce((sum, g) => sum + g.count, 0);

                return (
                    <div key={day.id} className="bg-white rounded-lg shadow-md p-6">
                        <div className="flex justify-between items-start mb-4 pb-4 border-b border-gray-200">
                            <div>
                                <h3 className="text-xl font-semibold text-gray-900">{day.name}</h3>
                                <p className="text-sm text-gray-600 mt-1">
                                    {day.date ? (() => {
                                        try {
                                            return format(parseISO(day.date), "d 'de' MMMM yyyy", { locale: ptBR });
                                        } catch {
                                            return day.date;
                                        }
                                    })() : 'Data não definida'}
                                </p>
                            </div>
                            <div className="text-right">
                                <div className="text-sm text-gray-600">Total de participantes</div>
                                <div className="text-2xl font-bold text-pink-600">{totalAttendees}</div>
                                <div className="text-xs text-gray-500 mt-1">
                                    <span className="text-green-600">{confirmedGroups.reduce((sum, g) => sum + g.count, 0)} confirmadas</span>
                                    {' / '}
                                    <span className="text-yellow-600">{pendingGroups.reduce((sum, g) => sum + g.count, 0)} pendentes</span>
                                </div>
                            </div>
                        </div>

                        {totalAttendees === 0 ? (
                            <p className="text-gray-500 text-center py-4">Nenhum participante inscrito para este dia.</p>
                        ) : (
                            <div className="space-y-6">
                                {confirmedGroups.length > 0 && (
                                    <div>
                                        <h4 className="text-lg font-semibold text-green-700 mb-3 flex items-center gap-2">
                                            <span className="w-2 h-2 bg-green-600 rounded-full"></span>
                                            Confirmadas ({confirmedGroups.reduce((sum, g) => sum + g.count, 0)})
                                        </h4>
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                            {confirmedGroups.map((group, idx) => (
                                                <div key={idx} className="bg-green-50 border border-green-200 rounded-lg p-4">
                                                    <div className="mb-3 pb-3 border-b border-green-300">
                                                        <div className="font-semibold text-gray-900">{group.parentName}</div>
                                                        <div className="text-xs text-gray-600 mt-1">{group.email}</div>
                                                        <div className="text-xs text-gray-600">{group.phone}</div>
                                                        {group.count > 1 && (
                                                            <div className="mt-2">
                                                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                                                                    👨‍👩‍👧‍👦 {group.count} irmãos
                                                                </span>
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="space-y-2">
                                                        {group.children.map((child, childIdx) => (
                                                            <div key={childIdx} className="flex items-start justify-between">
                                                                <div className="flex-1">
                                                                    <div className="font-medium text-gray-900">{child.childName}</div>
                                                                    <div className="text-xs text-gray-600">Idade: {child.childAge} anos</div>
                                                                </div>
                                                                {child.isStudyRoom && (
                                                                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 ml-2" title="Sala de Estudo">
                                                                        📚
                                                                    </span>
                                                                )}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {pendingGroups.length > 0 && (
                                    <div>
                                        <h4 className="text-lg font-semibold text-yellow-700 mb-3 flex items-center gap-2">
                                            <span className="w-2 h-2 bg-yellow-600 rounded-full"></span>
                                            Pendentes ({pendingGroups.reduce((sum, g) => sum + g.count, 0)})
                                        </h4>
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                            {pendingGroups.map((group, idx) => (
                                                <div key={idx} className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                                                    <div className="mb-3 pb-3 border-b border-yellow-300">
                                                        <div className="font-semibold text-gray-900">{group.parentName}</div>
                                                        <div className="text-xs text-gray-600 mt-1">{group.email}</div>
                                                        <div className="text-xs text-gray-600">{group.phone}</div>
                                                        {group.count > 1 && (
                                                            <div className="mt-2">
                                                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                                                                    👨‍👩‍👧‍👦 {group.count} irmãos
                                                                </span>
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="space-y-2">
                                                        {group.children.map((child, childIdx) => (
                                                            <div key={childIdx} className="flex items-start justify-between">
                                                                <div className="flex-1">
                                                                    <div className="font-medium text-gray-900">{child.childName}</div>
                                                                    <div className="text-xs text-gray-600">Idade: {child.childAge} anos</div>
                                                                </div>
                                                                {child.isStudyRoom && (
                                                                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 ml-2" title="Sala de Estudo">
                                                                        📚
                                                                    </span>
                                                                )}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function CampCalendarView({ dailyStats }: { dailyStats: Array<{ day: CampDay; confirmedKids: number; pendingKids: number; totalKids: number; capacity: number; remainingSpots: number }> }) {
    if (dailyStats.length === 0) {
        return <div className="text-center p-6 text-gray-500">Nenhum dia de campo configurado.</div>;
    }

    // Get all unique dates from camp days
    const campDates = dailyStats
        .map(stat => {
            try {
                return parseISO(stat.day.date);
            } catch {
                return null;
            }
        })
        .filter((date): date is Date => date !== null)
        .sort((a, b) => a.getTime() - b.getTime());

    if (campDates.length === 0) {
        return <div className="text-center p-6 text-gray-500">Nenhuma data válida encontrada.</div>;
    }

    const firstDate = campDates[0];
    const lastDate = campDates[campDates.length - 1];

    // Get the month range
    const startMonth = startOfMonth(firstDate);
    const endMonth = endOfMonth(lastDate);

    // Create a map of date strings to stats
    const statsByDate = new Map<string, typeof dailyStats[0]>();
    dailyStats.forEach(stat => {
        if (stat.day.date) {
            statsByDate.set(stat.day.date, stat);
        }
    });

    // Generate calendar weeks
    const weeks: Date[][] = [];
    let currentWeekStart = startOfWeek(startMonth, { weekStartsOn: 1 }); // Monday
    const calendarEnd = endOfWeek(endMonth, { weekStartsOn: 1 });

    while (currentWeekStart <= calendarEnd) {
        const week: Date[] = [];
        for (let i = 0; i < 7; i++) {
            const date = new Date(currentWeekStart);
            date.setDate(currentWeekStart.getDate() + i);
            week.push(date);
        }
        weeks.push(week);
        const nextWeek = new Date(currentWeekStart);
        nextWeek.setDate(currentWeekStart.getDate() + 7);
        currentWeekStart = nextWeek;
    }

    const weekDays = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

    return (
        <div className="bg-white rounded-lg shadow-md p-6">
            <div className="mb-4">
                <h3 className="text-lg font-semibold text-gray-700">
                    {format(startMonth, "MMMM yyyy", { locale: ptBR })}
                    {startMonth.getMonth() !== endMonth.getMonth() && ` - ${format(endMonth, "MMMM yyyy", { locale: ptBR })}`}
                </h3>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                    <thead>
                        <tr>
                            {weekDays.map(day => (
                                <th key={day} className="border border-gray-200 p-2 text-xs font-medium text-gray-600 bg-gray-50">
                                    {day}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {weeks.map((week, weekIdx) => (
                            <tr key={weekIdx}>
                                {week.map((date, dayIdx) => {
                                    const dateStr = format(date, 'yyyy-MM-dd');
                                    const stat = statsByDate.get(dateStr);
                                    const isInRange = date >= startMonth && date <= endMonth;
                                    const isCampDay = stat !== undefined;

                                    return (
                                        <td
                                            key={dayIdx}
                                            className={`border border-gray-200 p-2 min-w-[120px] ${!isInRange ? 'bg-gray-100' :
                                                isCampDay && stat.remainingSpots === 0 ? 'bg-red-50' :
                                                    isCampDay && stat.remainingSpots <= 3 ? 'bg-yellow-50' :
                                                        isCampDay ? 'bg-green-50' : 'bg-white'
                                                }`}
                                        >
                                            <div className="text-xs text-gray-500 mb-1">
                                                {format(date, 'd')}
                                            </div>
                                            {isCampDay && stat && (
                                                <div className="space-y-1">
                                                    <div className="text-xs font-semibold text-gray-900">{stat.day.name}</div>
                                                    <div className="space-y-0.5">
                                                        <div className="flex items-center justify-between">
                                                            <span className="text-xs text-gray-600">Confirmadas:</span>
                                                            <span className="text-xs text-green-600 font-semibold">{stat.confirmedKids}</span>
                                                        </div>
                                                        <div className="flex items-center justify-between">
                                                            <span className="text-xs text-gray-600">Pendentes:</span>
                                                            <span className="text-xs text-yellow-600 font-semibold">{stat.pendingKids}</span>
                                                        </div>
                                                        <div className="flex items-center justify-between border-t border-gray-200 pt-0.5">
                                                            <span className="text-xs font-medium text-gray-700">Total:</span>
                                                            <span className="text-xs font-bold text-gray-900">{stat.totalKids}</span>
                                                        </div>
                                                    </div>
                                                    <div className="text-xs text-gray-600 pt-0.5 border-t border-gray-200">
                                                        {stat.remainingSpots === 0 ? (
                                                            <span className="text-red-600 font-semibold">Esgotado</span>
                                                        ) : (
                                                            <span className={stat.remainingSpots <= 3 ? 'text-yellow-600' : 'text-green-600'}>
                                                                {stat.remainingSpots} vagas
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="text-xs text-gray-500">
                                                        Capacidade: {stat.capacity}
                                                    </div>
                                                </div>
                                            )}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="mt-4 flex gap-4 text-xs text-gray-600">
                <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-green-50 border border-gray-200"></div>
                    <span>Dia com vagas</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-yellow-50 border border-gray-200"></div>
                    <span>Poucas vagas (≤3)</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-red-50 border border-gray-200"></div>
                    <span>Esgotado</span>
                </div>
            </div>
            <div className="mt-2 text-xs text-gray-500">
                <span className="font-semibold">Legenda:</span> Confirmadas / Pendentes / Total
            </div>
        </div>
    );
}

function CampDayForm({
    day,
    onSave,
    onCancel,
}: {
    day: CampDay | null;
    onSave: (day: Omit<CampDay, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => void;
    onCancel: () => void;
}) {
    const [formData, setFormData] = useState({
        date: day?.date || '',
        name: day?.name || '',
        morning: day?.morning || '',
        lunch: day?.lunch || '',
        afternoon: day?.afternoon || '',
        capacity: day?.capacity || 20,
        price: day?.price || 0,
        active: day?.active ?? true,
    });

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        // Validate required fields
        if (!formData.date || !formData.name || !formData.morning || !formData.lunch || !formData.afternoon) {
            return; // Browser validation will handle this
        }

        onSave({
            ...formData,
            id: day?.id,
        });
    };

    return (
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
            <h3 className="text-xl font-semibold mb-4">{day ? 'Editar Dia' : 'Novo Dia'}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label className="block text-sm font-medium mb-1">Data</label>
                    <input
                        type="date"
                        required
                        value={formData.date}
                        onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                        className="w-full px-3 py-2 border rounded"
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium mb-1">Nome</label>
                    <input
                        type="text"
                        required
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        className="w-full px-3 py-2 border rounded"
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium mb-1">Manhã</label>
                    <textarea
                        required
                        value={formData.morning}
                        onChange={(e) => setFormData({ ...formData, morning: e.target.value })}
                        className="w-full px-3 py-2 border rounded"
                        rows={2}
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium mb-1">Almoço</label>
                    <textarea
                        required
                        value={formData.lunch}
                        onChange={(e) => setFormData({ ...formData, lunch: e.target.value })}
                        className="w-full px-3 py-2 border rounded"
                        rows={2}
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium mb-1">Tarde</label>
                    <textarea
                        required
                        value={formData.afternoon}
                        onChange={(e) => setFormData({ ...formData, afternoon: e.target.value })}
                        className="w-full px-3 py-2 border rounded"
                        rows={2}
                    />
                </div>
                <div className="grid grid-cols-3 gap-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">Capacidade</label>
                        <input
                            type="number"
                            required
                            min="1"
                            value={formData.capacity || ''}
                            onChange={(e) => setFormData({ ...formData, capacity: parseInt(e.target.value) || 0 })}
                            className="w-full px-3 py-2 border rounded"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Preço (€)</label>
                        <input
                            type="number"
                            required
                            min="0"
                            step="0.01"
                            value={formData.price || ''}
                            onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })}
                            className="w-full px-3 py-2 border rounded"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Estado</label>
                        <select
                            value={formData.active ? 'active' : 'inactive'}
                            onChange={(e) => setFormData({ ...formData, active: e.target.value === 'active' })}
                            className="w-full px-3 py-2 border rounded"
                        >
                            <option value="active">Ativo</option>
                            <option value="inactive">Inativo</option>
                        </select>
                    </div>
                </div>
                <div className="flex gap-2">
                    <button type="submit" className="bg-pink-600 text-white px-4 py-2 rounded hover:bg-pink-700">
                        Guardar
                    </button>
                    <button type="button" onClick={onCancel} className="bg-gray-300 px-4 py-2 rounded hover:bg-gray-400">
                        Cancelar
                    </button>
                </div>
            </form>
        </div>
    );
}

