import { collection, doc, getDoc, getDocs, addDoc, updateDoc, query, where, Timestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { CampDay, CampBooking, CampConfig } from '@shared/models/Camp';

const safeDate = (d: any): Date => {
    if (!d) return new Date();
    if (d instanceof Date) return d;
    if (d.toDate && typeof d.toDate === 'function') return d.toDate();
    if (typeof d === 'string') return new Date(d);
    if (d._seconds) return new Date(d._seconds * 1000);
    return new Date();
};

export const campService = {
    // Camp Days
    async getCampDays(): Promise<CampDay[]> {
        const daysSnap = await getDocs(collection(db, 'campDays'));
        return daysSnap.docs.map((d) => {
            const data = d.data();
            return {
                id: d.id,
                date: String(data.date ?? ''),
                name: String(data.name ?? ''),
                morning: String(data.morning ?? ''),
                lunch: String(data.lunch ?? ''),
                afternoon: String(data.afternoon ?? ''),
                capacity: Number(data.capacity ?? 0),
                price: Number(data.price ?? 0),
                active: Boolean(data.active ?? true),
                createdAt: safeDate(data.createdAt),
                updatedAt: safeDate(data.updatedAt),
            };
        }).sort((a, b) => a.date.localeCompare(b.date));
    },

    async getCampDay(id: string): Promise<CampDay | null> {
        const dayDoc = await getDoc(doc(db, 'campDays', id));
        if (!dayDoc.exists()) return null;
        const data = dayDoc.data();
        return {
            id: dayDoc.id,
            date: String(data.date ?? ''),
            name: String(data.name ?? ''),
            morning: String(data.morning ?? ''),
            lunch: String(data.lunch ?? ''),
            afternoon: String(data.afternoon ?? ''),
            capacity: Number(data.capacity ?? 0),
            price: Number(data.price ?? 0),
            active: Boolean(data.active ?? true),
            createdAt: safeDate(data.createdAt),
            updatedAt: safeDate(data.updatedAt),
        };
    },

    async saveCampDay(day: Omit<CampDay, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<string> {
        if (day.id) {
            // Update existing document - exclude id from the update data
            const { id, ...updateData } = day;
            await updateDoc(doc(db, 'campDays', id), {
                ...updateData,
                updatedAt: Timestamp.now(),
            });
            return id;
        } else {
            // Create new document - exclude id field completely
            const { id, ...createData } = day;
            const docRef = await addDoc(collection(db, 'campDays'), {
                ...createData,
                createdAt: Timestamp.now(),
                updatedAt: Timestamp.now(),
            });
            return docRef.id;
        }
    },

    // Get bookings for a specific day to check capacity
    async getBookingsForDay(dayId: string): Promise<CampBooking[]> {
        const bookingsSnap = await getDocs(
            query(collection(db, 'campBookings'), where('selectedDays', 'array-contains', dayId))
        );
        return bookingsSnap.docs
            .map((d) => {
                const data = d.data();
                return {
                    id: d.id,
                    childName: String(data.childName ?? ''),
                    childAge: Number(data.childAge ?? 0),
                    childDateOfBirth: data.childDateOfBirth ? String(data.childDateOfBirth) : undefined,
                    parentName: String(data.parentName ?? ''),
                    email: String(data.email ?? ''),
                    phone: String(data.phone ?? ''),
                    selectedDays: Array.isArray(data.selectedDays) ? data.selectedDays.map(String) : [],
                    totalPrice: Number(data.totalPrice ?? 0),
                    familyId: data.familyId ? String(data.familyId) : undefined,
                    childId: data.childId ? String(data.childId) : undefined,
                    status: (data.status as 'pending' | 'confirmed' | 'cancelled') ?? 'pending',
                    statusReason: data.statusReason ? String(data.statusReason) : undefined,
                    notes: data.notes ? String(data.notes) : undefined,
                    createdAt: safeDate(data.createdAt),
                    updatedAt: safeDate(data.updatedAt),
                };
            })
            .filter((b) => b.status !== 'cancelled');
    },

    async getAvailableSpots(dayId: string): Promise<number> {
        const day = await this.getCampDay(dayId);
        if (!day) return 0;

        const bookings = await this.getBookingsForDay(dayId);
        const bookedSpots = bookings.length;
        return Math.max(0, day.capacity - bookedSpots);
    },

    // Camp Bookings
    async createBooking(booking: Omit<CampBooking, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
        // Check capacity for all selected days
        for (const dayId of booking.selectedDays) {
            const available = await this.getAvailableSpots(dayId);
            if (available <= 0) {
                throw new Error(`No spots available for ${dayId}`);
            }
        }

        // Remove undefined fields before saving
        const bookingData: any = {
            childName: booking.childName,
            childAge: booking.childAge,
            parentName: booking.parentName,
            email: booking.email,
            phone: booking.phone,
            selectedDays: booking.selectedDays,
            totalPrice: booking.totalPrice,
            status: 'pending',
            createdAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
        };

        // Only add optional fields if they have values
        if (booking.childDateOfBirth) {
            bookingData.childDateOfBirth = booking.childDateOfBirth;
        }
        if (booking.familyId) {
            bookingData.familyId = booking.familyId;
        }
        if (booking.childId) {
            bookingData.childId = booking.childId;
        }
        if (booking.notes) {
            bookingData.notes = booking.notes;
        }

        const docRef = await addDoc(collection(db, 'campBookings'), bookingData);
        return docRef.id;
    },

    async getBookings(): Promise<CampBooking[]> {
        const bookingsSnap = await getDocs(collection(db, 'campBookings'));
        return bookingsSnap.docs
            .map((d) => {
                const data = d.data();
                return {
                    id: d.id,
                    childName: String(data.childName ?? ''),
                    childAge: Number(data.childAge ?? 0),
                    childDateOfBirth: data.childDateOfBirth ? String(data.childDateOfBirth) : undefined,
                    parentName: String(data.parentName ?? ''),
                    email: String(data.email ?? ''),
                    phone: String(data.phone ?? ''),
                    selectedDays: Array.isArray(data.selectedDays) ? data.selectedDays.map(String) : [],
                    totalPrice: Number(data.totalPrice ?? 0),
                    familyId: data.familyId ? String(data.familyId) : undefined,
                    childId: data.childId ? String(data.childId) : undefined,
                    status: (data.status as 'pending' | 'confirmed' | 'cancelled') ?? 'pending',
                    statusReason: data.statusReason ? String(data.statusReason) : undefined,
                    notes: data.notes ? String(data.notes) : undefined,
                    createdAt: safeDate(data.createdAt),
                    updatedAt: safeDate(data.updatedAt),
                };
            })
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async updateBookingStatus(id: string, status: 'pending' | 'confirmed' | 'cancelled', reason?: string): Promise<void> {
        const updateData: any = {
            status,
            updatedAt: Timestamp.now(),
        };

        // Only include statusReason if provided
        if (reason) {
            updateData.statusReason = reason;
        }

        await updateDoc(doc(db, 'campBookings', id), updateData);
    },

    // Camp Config
    async getCampConfig(): Promise<CampConfig | null> {
        const configDoc = await getDoc(doc(db, 'config', 'camp'));
        if (!configDoc.exists()) return null;
        const data = configDoc.data();
        return {
            name: String(data.name ?? 'Actividades de natal 2025'),
            startDate: String(data.startDate ?? ''),
            endDate: String(data.endDate ?? ''),
            description: data.description ? String(data.description) : undefined,
            wholeWeekDiscount: data.wholeWeekDiscount ? Number(data.wholeWeekDiscount) : undefined,
            earlyBirdDiscount: data.earlyBirdDiscount ? Number(data.earlyBirdDiscount) : undefined,
            earlyBirdDeadline: data.earlyBirdDeadline ? String(data.earlyBirdDeadline) : undefined,
            contactEmail: data.contactEmail ? String(data.contactEmail) : undefined,
            contactPhone: data.contactPhone ? String(data.contactPhone) : undefined,
            termsAndConditions: data.termsAndConditions ? String(data.termsAndConditions) : undefined,
            updatedAt: safeDate(data.updatedAt),
        };
    },

    async saveCampConfig(config: CampConfig): Promise<void> {
        await updateDoc(doc(db, 'config', 'camp'), {
            ...config,
            updatedAt: Timestamp.now(),
        });
    },
};

