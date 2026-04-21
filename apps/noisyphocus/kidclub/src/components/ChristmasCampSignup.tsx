import { useState, useEffect } from 'react';
import { campService } from '../services/campService';
import { CampDay, CampBooking } from '@shared/models/Camp';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export default function ChristmasCampSignup() {
    const [campDays, setCampDays] = useState<CampDay[]>([]);
    const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set());
    const [formData, setFormData] = useState({
        childName: '',
        childAge: '',
        childDateOfBirth: '',
        parentName: '',
        email: '',
        phone: '',
        notes: '',
    });
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [availableSpots, setAvailableSpots] = useState<Record<string, number>>({});
    const [campConfig, setCampConfig] = useState<any>(null);

    useEffect(() => {
        loadCampDays();
        loadCampConfig();
    }, []);

    useEffect(() => {
        // Load available spots for each day
        const loadSpots = async () => {
            const spots: Record<string, number> = {};
            for (const day of campDays) {
                spots[day.id] = await campService.getAvailableSpots(day.id);
            }
            setAvailableSpots(spots);
        };
        if (campDays.length > 0) {
            loadSpots();
        }
    }, [campDays]);

    const loadCampConfig = async () => {
        const config = await campService.getCampConfig();
        setCampConfig(config);
    };

    const loadCampDays = async () => {
        try {
            const days = await campService.getCampDays();
            setCampDays(days.filter((d: CampDay) => d.active));
        } catch (err) {
            setError('Erro ao carregar dias do campo. Por favor, recarregue a página.');
        } finally {
            setIsLoading(false);
        }
    };

    const toggleDay = (dayId: string) => {
        setSelectedDays((prev) => {
            const newSet = new Set(prev);
            if (newSet.has(dayId)) {
                newSet.delete(dayId);
            } else {
                newSet.add(dayId);
            }
            return newSet;
        });
    };

    const selectAllDays = () => {
        setSelectedDays(new Set(campDays.map((d) => d.id)));
    };

    const clearSelection = () => {
        setSelectedDays(new Set());
    };

    const calculateTotal = (): number => {
        let total = 0;
        selectedDays.forEach((dayId) => {
            const day = campDays.find((d) => d.id === dayId);
            if (day) {
                total += day.price;
            }
        });

        // Apply whole week discount if all days selected
        if (campConfig?.wholeWeekDiscount && selectedDays.size === campDays.length) {
            total = total * (1 - campConfig.wholeWeekDiscount / 100);
        }

        return total;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);

        if (selectedDays.size === 0) {
            setError('Por favor, selecione pelo menos um dia.');
            return;
        }

        if (!formData.childName || !formData.parentName || !formData.email || !formData.phone) {
            setError('Por favor, preencha todos os campos obrigatórios.');
            return;
        }

        setIsSubmitting(true);

        try {
            const booking: Omit<CampBooking, 'id' | 'createdAt' | 'updatedAt'> = {
                childName: formData.childName,
                childAge: parseInt(formData.childAge) || 0,
                childDateOfBirth: formData.childDateOfBirth || undefined,
                parentName: formData.parentName,
                email: formData.email,
                phone: formData.phone,
                selectedDays: Array.from(selectedDays),
                totalPrice: calculateTotal(),
                notes: formData.notes || undefined,
                status: 'pending',
            };

            await campService.createBooking(booking);
            setSubmitted(true);
        } catch (err: any) {
            setError(err.message || 'Erro ao submeter inscrição. Por favor, tente novamente.');
        } finally {
            setIsSubmitting(false);
        }
    };

    if (submitted) {
        return (
            <div className="max-w-4xl mx-auto p-6 bg-green-50 border-2 border-green-500 rounded-lg">
                <h2 className="text-2xl font-bold text-green-800 mb-4">✅ Inscrição Enviada com Sucesso!</h2>
                <p className="text-gray-700 mb-4">
                    Obrigado pela sua inscrição! Receberá um email de confirmação em breve.
                </p>
                <p className="text-sm text-gray-600">
                    Entraremos em contacto para confirmar os detalhes e o pagamento.
                </p>
            </div>
        );
    }

    if (isLoading) {
        return <div className="text-center p-6">A carregar...</div>;
    }

    const total = calculateTotal();
    const allSelected = selectedDays.size === campDays.length;

    return (
        <div className="max-w-6xl mx-auto p-6">
            <h2 className="text-3xl font-bold text-center text-pink-600 mb-6">
                🎄 Actividades de natal 2025 - Inscrições
            </h2>

            {error && (
                <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
                    {error}
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Days Selection */}
                <div className="lg:col-span-2">
                    <div className="bg-white rounded-lg shadow-md p-6 mb-4">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-xl font-semibold">Selecione os Dias</h3>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={selectAllDays}
                                    className="text-sm px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
                                >
                                    Selecionar Todos
                                </button>
                                <button
                                    type="button"
                                    onClick={clearSelection}
                                    className="text-sm px-3 py-1 bg-gray-300 text-gray-700 rounded hover:bg-gray-400"
                                >
                                    Limpar
                                </button>
                            </div>
                        </div>

                        <div className="space-y-3">
                            {campDays.map((day) => {
                                const isSelected = selectedDays.has(day.id);
                                const spots = availableSpots[day.id] ?? 0;
                                const isFull = spots === 0;

                                return (
                                    <div
                                        key={day.id}
                                        className={`border-2 rounded-lg p-4 cursor-pointer transition-all ${isSelected
                                            ? 'border-pink-500 bg-pink-50'
                                            : isFull
                                                ? 'border-gray-300 bg-gray-100 opacity-60 cursor-not-allowed'
                                                : 'border-gray-300 hover:border-pink-300'
                                            }`}
                                        onClick={() => !isFull && toggleDay(day.id)}
                                    >
                                        <div className="flex items-start justify-between">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <input
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        onChange={() => !isFull && toggleDay(day.id)}
                                                        disabled={isFull}
                                                        className="w-5 h-5 text-pink-600"
                                                    />
                                                    <h4 className="font-semibold text-lg">{day.name}</h4>
                                                    <span className="text-sm text-gray-500">
                                                        {day.date ? (() => {
                                                            try {
                                                                return format(parseISO(day.date), "d 'de' MMMM", { locale: ptBR });
                                                            } catch {
                                                                return day.date;
                                                            }
                                                        })() : 'Data não definida'}
                                                    </span>
                                                </div>
                                                <div className="ml-7 space-y-1 text-sm text-gray-600">
                                                    <p><strong>Manhã:</strong> {day.morning}</p>
                                                    <p><strong>Almoço:</strong> {day.lunch}</p>
                                                    <p><strong>Tarde:</strong> {day.afternoon}</p>
                                                </div>
                                            </div>
                                            <div className="text-right ml-4">
                                                <div className="text-xl font-bold text-pink-600">€{day.price.toFixed(2)}</div>
                                                <div className="text-xs text-gray-500 mt-1">
                                                    {isFull ? (
                                                        <span className="text-red-600 font-semibold">Esgotado</span>
                                                    ) : (
                                                        <span>{spots} vagas</span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* Form & Summary */}
                <div className="lg:col-span-1">
                    <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-md p-6 space-y-4">
                        <h3 className="text-xl font-semibold mb-4">Dados da Inscrição</h3>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Nome da Criança *
                            </label>
                            <input
                                type="text"
                                required
                                value={formData.childName}
                                onChange={(e) => setFormData({ ...formData, childName: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-pink-500"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Idade da Criança *
                            </label>
                            <input
                                type="number"
                                required
                                min="0"
                                max="18"
                                value={formData.childAge}
                                onChange={(e) => setFormData({ ...formData, childAge: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-pink-500"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Data de Nascimento (opcional)
                            </label>
                            <input
                                type="date"
                                value={formData.childDateOfBirth}
                                onChange={(e) => setFormData({ ...formData, childDateOfBirth: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-pink-500"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Nome do Encarregado de Educação *
                            </label>
                            <input
                                type="text"
                                required
                                value={formData.parentName}
                                onChange={(e) => setFormData({ ...formData, parentName: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-pink-500"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Email *
                            </label>
                            <input
                                type="email"
                                required
                                value={formData.email}
                                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-pink-500"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Telefone *
                            </label>
                            <input
                                type="tel"
                                required
                                value={formData.phone}
                                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-pink-500"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Observações (alergias, restrições alimentares, etc.)
                            </label>
                            <textarea
                                value={formData.notes}
                                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                                rows={3}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-pink-500"
                            />
                        </div>

                        {/* Summary */}
                        <div className="border-t pt-4 mt-4">
                            <div className="flex justify-between mb-2">
                                <span className="font-medium">Dias selecionados:</span>
                                <span>{selectedDays.size} de {campDays.length}</span>
                            </div>
                            {allSelected && (
                                <div className="text-sm text-green-600 mb-2">
                                    ✓ Desconto de semana completa aplicado!
                                </div>
                            )}
                            <div className="flex justify-between text-xl font-bold text-pink-600">
                                <span>Total:</span>
                                <span>€{total.toFixed(2)}</span>
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={isSubmitting || selectedDays.size === 0}
                            className="w-full bg-pink-600 text-white py-3 px-4 rounded-md font-semibold hover:bg-pink-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                        >
                            {isSubmitting ? 'A enviar...' : 'Submeter Inscrição'}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}

