import { useEffect, useMemo, useState } from "react";
import {
  collection, getDocs, orderBy, query, doc, getDoc, addDoc, serverTimestamp, where
} from "firebase/firestore";
import { db } from "@shared/firebase";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { useOrgs } from "../hooks/OrgContext";
import { toDate } from "../lib/api/utils";

type Person = { id: string; name: string };
type PlannedInstance = {
  id: string;
  label: string;
  kind: "single"|"transfer"|"split";
  currency: string;
  date: Date | null;
  status: "draft"|"posted";
  meta?: { personId?: string };
};

export default function PlannedInstancesPage() {
  const { selectedOrgId } = useOrgs();

  const [instances, setInstances] = useState<PlannedInstance[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string|null>(null);

  const loadOrgData = async () => {
    if (!selectedOrgId) return;
    setBusy(true);
    setMsg(`Loading data for ${selectedOrgId}...`);
    try {
      const plannedQuery = query(collection(db, "orgs", selectedOrgId, "plannedInstances"), orderBy("date", "asc"));
      const peopleQuery = query(collection(db, "orgs", selectedOrgId, "people"));

      const [plannedSnap, peopleSnap] = await Promise.all([getDocs(plannedQuery), getDocs(peopleQuery)]);

      const loadedInstances = plannedSnap.docs.map(d => {
        const x = d.data() as any;
        return { ...x, id: d.id, date: toDate(x.date) } as PlannedInstance;
      });
      setInstances(loadedInstances);

      const loadedPeople = peopleSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      setPeople(loadedPeople);
      setMsg(`${loadedInstances.length} events loaded.`);

    } catch(e: any) {
      console.error(e);
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    loadOrgData();
  }, [selectedOrgId]);

  const peopleById = useMemo(() => {
    const map = new Map<string, Person>();
    people.forEach(p => map.set(p.id, p));
    return map;
  }, [people]);

  const handleSyncBooking = async () => {
    if (!selectedOrgId) {
      setMsg("Please select an organization first.");
      return;
    }
    setBusy(true);
    setMsg("Syncing booking directly from the database...");
    try {
      const bookingId = "PVARypDy7SLFqYAs6JMp";
      // 1. Fetch the booking data.
      const bookingRef = doc(db, "bookings", bookingId);
      const bookingSnap = await getDoc(bookingRef);

      if (!bookingSnap.exists()) {
        throw new Error(`Booking with ID ${bookingId} not found.`);
      }
      const bookingData = bookingSnap.data();

      // 2. Find the correct category to assign the income to.
      const categoriesRef = collection(db, `orgs/${selectedOrgId}/categories`);
      const categoryQuery = query(categoriesRef, where("systemRole", "==", "INCOME_PARTY_BOOKING"));
      const categorySnap = await getDocs(categoryQuery);

      if (categorySnap.empty) {
        throw new Error(`No category with systemRole 'INCOME_PARTY_BOOKING' found for org '${selectedOrgId}'.`);
      }
      const incomeCategoryId = categorySnap.docs[0].id;

      // 3. Prepare the PlannedEvent data.
      const plannedEvent = {
        label: `Income - Party: ${bookingData.childName || bookingId}`,
        kind: "income",
        currency: "EUR",
        date: bookingData.date, // Assuming the date is already a Timestamp or a format Firestore understands
        status: "draft",
        amountCents: bookingData.total * 100, // Assuming total is in EUR, convert to cents
        categoryId: incomeCategoryId,
        meta: {
          source: "arcoiris-booking",
          bookingId: bookingId,
          companyId: selectedOrgId,
        },
        createdAt: serverTimestamp(),
      };

      // 4. Create the new PlannedEvent document.
      const plannedEventRef = await addDoc(collection(db, `orgs/${selectedOrgId}/plannedInstances`), plannedEvent);

      setMsg(`Successfully created planned event ${plannedEventRef.id} for booking ${bookingId} in org ${selectedOrgId}.`);
      await loadOrgData(); // Refresh the list
    } catch (error: any) {
      console.error(error);
      setMsg(error.message);
    } finally {
      setBusy(false);
    }
  };

  const fmtDate = (d: Date | null) => {
    if (!d || isNaN(d.getTime())) return "—";
    return d.toLocaleDateString();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Planned Instances</h2>
        <Button onClick={handleSyncBooking} disabled={busy}>Sync Booking (Direct DB)</Button>
      </div>
      
      {msg && <div className="text-sm text-emerald-400">{msg}</div>}
      {busy && <div className="text-sm text-zinc-400">Loading...</div>}

      <Card className="overflow-x-auto">
        <table className="min-w-full text-sm text-left">
          <thead>
            <tr className="border-b border-zinc-700 text-zinc-300">
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Label</th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Currency</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {instances.map(inst=>{
              const ownerName = inst.meta?.personId ? peopleById.get(inst.meta.personId)?.name : "N/A";
              return (
                <tr key={inst.id} className="border-b border-zinc-800">
                  <td className="px-3 py-2">{fmtDate(inst.date)}</td>
                  <td className="px-3 py-2">{inst.label}</td>
                  <td className="px-3 py-2">{ownerName}</td>
                  <td className="px-3 py-2 capitalize">{inst.kind}</td>
                  <td className="px-3 py-2">{inst.currency}</td>
                  <td className="px-3 py-2 capitalize">{inst.status}</td>
                </tr>
              )
            })}
            {!instances.length && !busy && (
              <tr><td colSpan={6} className="px-3 py-6 text-zinc-500">No planned instances found for this organization.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
