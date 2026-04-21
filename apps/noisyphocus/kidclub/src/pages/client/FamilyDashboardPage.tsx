import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { db } from '../../lib/firebase';
import { collection, getDocs, query, where, doc, getDoc, addDoc, updateDoc } from 'firebase/firestore';
import { Family, Child, StudyRoomEntry, TransportationSubscription, Booking } from '@shared/models';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { calculateAge } from '../../lib/utils';

interface ChildSubscriptions {
  child: Child;
  study: StudyRoomEntry[];
  transport: TransportationSubscription[];
  parties: Booking[];
}

export default function FamilyDashboardPage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [studySubscriptions, setStudySubscriptions] = useState<StudyRoomEntry[]>([]);
  const [transportSubscriptions, setTransportSubscriptions] = useState<TransportationSubscription[]>([]);
  const [partyBookings, setPartyBookings] = useState<Booking[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [linkingSubscriptions, setLinkingSubscriptions] = useState<Set<string>>(new Set());

  const getChildName = (record: { childName?: string;[key: string]: any }) =>
    record?.childName || record?.studentName || '';

  const getSubscriptionDisplayName = (record: { childName?: string;[key: string]: any }) =>
    getChildName(record) || 'Unnamed';

  useEffect(() => {
    if (user) {
      const fetchFamilyData = async () => {
        setIsLoading(true);

        try {
          // Find family by userId
          const familiesQuery = query(
            collection(db, 'families'),
            where('primaryContact.userId', '==', user.uid)
          );
          const familiesSnapshot = await getDocs(familiesQuery);

          if (familiesSnapshot.empty) {
            // Create family account if it doesn't exist
            const newFamily: Omit<Family, 'id'> = {
              primaryContact: {
                name: user.name || user.email?.split('@')[0] || 'User',
                email: user.email || '',
                phone: '',
                userId: user.uid,
              },
              status: 'active',
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            const familyRef = await addDoc(collection(db, 'families'), newFamily);
            const familyData = {
              ...newFamily,
              id: familyRef.id,
            } as Family;
            setFamily(familyData);
            // Fetch children for the new family (will be empty initially)
            setChildren([]);
            setStudySubscriptions([]);
            setTransportSubscriptions([]);
            setPartyBookings([]);
            setIsLoading(false);
            return;
          }

          if (!familiesSnapshot.empty) {
            const familyData = {
              ...familiesSnapshot.docs[0].data(),
              id: familiesSnapshot.docs[0].id,
              createdAt: familiesSnapshot.docs[0].data().createdAt?.toDate?.() || new Date(familiesSnapshot.docs[0].data().createdAt),
              updatedAt: familiesSnapshot.docs[0].data().updatedAt?.toDate?.() || new Date(familiesSnapshot.docs[0].data().updatedAt),
            } as Family;
            setFamily(familyData);

            const familyId = familyData.id;

            // Fetch children
            const childrenQuery = query(
              collection(db, 'children'),
              where('familyId', '==', familyId),
              where('status', '==', 'active')
            );
            const childrenSnapshot = await getDocs(childrenQuery);
            const childrenData = childrenSnapshot.docs.map(doc => {
              const data = doc.data();
              return {
                ...data,
                id: doc.id,
                dateOfBirth: data.dateOfBirth?.toDate?.() || new Date(data.dateOfBirth),
                createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
                updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
                age: data.age || calculateAge(data.dateOfBirth?.toDate?.() || new Date(data.dateOfBirth)),
              } as Child;
            });
            setChildren(childrenData);

            // Fetch study room subscriptions - try both new model (familyId) and legacy (userId)
            const studyQueryNew = query(
              collection(db, 'studyroom'),
              where('familyId', '==', familyId)
            );
            const studySnapshotNew = await getDocs(studyQueryNew);

            // Also fetch legacy subscriptions by userId
            const studyQueryLegacy = query(
              collection(db, 'studyroom'),
              where('userId', '==', user.uid)
            );
            const studySnapshotLegacy = await getDocs(studyQueryLegacy);

            // Combine and deduplicate
            const allStudyDocs = [...studySnapshotNew.docs];
            studySnapshotLegacy.docs.forEach(doc => {
              if (!allStudyDocs.find(d => d.id === doc.id)) {
                allStudyDocs.push(doc);
              }
            });

            const studySubs = allStudyDocs.map(doc => {
              const data = doc.data();
              // Try to match to a child by name if not already linked
              let matchedChildId = data.childId;
              if (!matchedChildId && data.studentName && childrenData.length > 0) {
                const nameParts = data.studentName.trim().split(/\s+/);
                const firstName = nameParts[0] || '';
                const lastName = nameParts.slice(1).join(' ') || '';
                const matchedChild = childrenData.find(child =>
                  child.firstName.toLowerCase() === firstName.toLowerCase() &&
                  (lastName === '' || child.lastName.toLowerCase() === lastName.toLowerCase())
                );
                if (matchedChild) {
                  matchedChildId = matchedChild.id;
                }
              }

              return {
                ...data,
                id: doc.id,
                familyId: data.familyId || familyId,
                childId: matchedChildId || data.childId,
                childName: data.childName || data.studentName || '',
                startDate: data.startDate?.toDate?.() || new Date(data.startDate),
                endDate: data.endDate?.toDate?.() || new Date(data.endDate),
                createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
                updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
              } as StudyRoomEntry;
            });
            setStudySubscriptions(studySubs);

            // Fetch transport subscriptions - try both new model (familyId) and legacy (userId/email)
            const transportQueryNew = query(
              collection(db, 'transportationSubscriptions'),
              where('familyId', '==', familyId)
            );
            const transportSnapshotNew = await getDocs(transportQueryNew);

            // Also fetch legacy subscriptions by userId
            const transportQueryLegacy = query(
              collection(db, 'transportationSubscriptions'),
              where('userId', '==', user.uid)
            );
            const transportSnapshotLegacy = await getDocs(transportQueryLegacy);

            // Also try by email if available
            let transportByEmail = { docs: [] as any[] };
            if (user.email) {
              const transportQueryByEmail = query(
                collection(db, 'transportationSubscriptions'),
                where('contactEmail', '==', user.email)
              );
              transportByEmail = await getDocs(transportQueryByEmail);
            }

            // Combine and deduplicate
            const allTransportDocs = [...transportSnapshotNew.docs];
            [...transportSnapshotLegacy.docs, ...transportByEmail.docs].forEach(doc => {
              if (!allTransportDocs.find(d => d.id === doc.id)) {
                allTransportDocs.push(doc);
              }
            });

            const transportSubs = allTransportDocs.map(doc => {
              const data = doc.data();
              // Try to match to a child by name if not already linked
              let matchedChildId = data.childId;
              if (!matchedChildId && data.studentName && childrenData.length > 0) {
                const nameParts = data.studentName.trim().split(/\s+/);
                const firstName = nameParts[0] || '';
                const lastName = nameParts.slice(1).join(' ') || '';
                const matchedChild = childrenData.find(child =>
                  child.firstName.toLowerCase() === firstName.toLowerCase() &&
                  (lastName === '' || child.lastName.toLowerCase() === lastName.toLowerCase())
                );
                if (matchedChild) {
                  matchedChildId = matchedChild.id;
                }
              }

              return {
                ...data,
                id: doc.id,
                familyId: data.familyId || familyId,
                childId: matchedChildId || data.childId,
                childName: data.childName || data.studentName || '',
                createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
                updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
              } as TransportationSubscription;
            });
            setTransportSubscriptions(transportSubs);

            // Fetch party bookings - try both new model (familyId) and legacy (email)
            const partiesQueryNew = query(
              collection(db, 'bookings'),
              where('familyId', '==', familyId)
            );
            const partiesSnapshotNew = await getDocs(partiesQueryNew);

            // Also fetch legacy bookings by email
            let partiesByEmail = { docs: [] as any[] };
            if (user.email) {
              const partiesQueryByEmail = query(
                collection(db, 'bookings'),
                where('email', '==', user.email)
              );
              partiesByEmail = await getDocs(partiesQueryByEmail);
            }

            // Combine and deduplicate
            const allPartyDocs = [...partiesSnapshotNew.docs];
            partiesByEmail.docs.forEach(doc => {
              if (!allPartyDocs.find(d => d.id === doc.id)) {
                allPartyDocs.push(doc);
              }
            });

            const partySubs = allPartyDocs.map(doc => {
              const data = doc.data();
              // Try to match to a child by name if not already linked
              let matchedChildId = data.childId;
              if (!matchedChildId && data.childName && childrenData.length > 0) {
                const nameParts = data.childName.trim().split(/\s+/);
                const firstName = nameParts[0] || '';
                const lastName = nameParts.slice(1).join(' ') || '';
                const matchedChild = childrenData.find(child =>
                  child.firstName.toLowerCase() === firstName.toLowerCase() &&
                  (lastName === '' || child.lastName.toLowerCase() === lastName.toLowerCase())
                );
                if (matchedChild) {
                  matchedChildId = matchedChild.id;
                }
              }

              return {
                ...data,
                id: doc.id,
                familyId: data.familyId || familyId,
                childId: matchedChildId || data.childId,
                createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
              } as Booking;
            });
            setPartyBookings(partySubs);
          }
        } catch (error) {
          console.error('Error fetching family data:', error);
        } finally {
          setIsLoading(false);
        }
      };

      fetchFamilyData();
    }
  }, [user]);

  // Group subscriptions by child (including matched subscriptions)
  const subscriptionsByChild = children.reduce((acc, child) => {
    acc[child.id] = {
      child,
      study: studySubscriptions.filter(s => s.childId === child.id),
      transport: transportSubscriptions.filter(t => t.childId === child.id),
      parties: partyBookings.filter(p => p.childId === child.id),
    };
    return acc;
  }, {} as Record<string, ChildSubscriptions>);

  // Find unlinked subscriptions (those without a childId match)
  const unlinkedStudy = studySubscriptions.filter(s => !s.childId || !children.find(c => c.id === s.childId));
  const unlinkedTransport = transportSubscriptions.filter(t => !t.childId || !children.find(c => c.id === t.childId));

  // Function to link a subscription to a child
  const handleLinkSubscription = async (subscription: StudyRoomEntry | TransportationSubscription, childId: string, type: 'study' | 'transport') => {
    const subId = subscription.id;
    setLinkingSubscriptions(prev => new Set(prev).add(subId));

    try {
      const child = children.find(c => c.id === childId);
      if (!child) {
        alert('Child not found');
        return;
      }

      const updates: any = {
        childId,
        childName: `${child.firstName} ${child.lastName}`,
        familyId: family?.id || subscription.familyId,
        updatedAt: new Date(),
      };

      if (type === 'study') {
        if (subscription.childAge === undefined && child.age) {
          updates.childAge = child.age;
        }
        await updateDoc(doc(db, 'studyroom', subId), updates);
      } else {
        if (subscription.childAge === undefined && child.age) {
          updates.childAge = child.age;
        }
        await updateDoc(doc(db, 'transportationSubscriptions', subId), updates);
      }

      // Refresh data
      const fetchFamilyData = async () => {
        if (!user || !family) return;

        const familyId = family.id;
        const childrenQuery = query(
          collection(db, 'children'),
          where('familyId', '==', familyId),
          where('status', '==', 'active')
        );
        const childrenSnapshot = await getDocs(childrenQuery);
        const childrenData = childrenSnapshot.docs.map(doc => {
          const data = doc.data();
          return {
            ...data,
            id: doc.id,
            dateOfBirth: data.dateOfBirth?.toDate?.() || new Date(data.dateOfBirth),
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
            updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
            age: data.age || calculateAge(data.dateOfBirth?.toDate?.() || new Date(data.dateOfBirth)),
          } as Child;
        });
        setChildren(childrenData);

        // Re-fetch subscriptions
        const allStudyDocs = [...(await getDocs(query(collection(db, 'studyroom'), where('familyId', '==', familyId)))).docs];
        const legacyStudy = (await getDocs(query(collection(db, 'studyroom'), where('userId', '==', user.uid)))).docs;
        legacyStudy.forEach(d => {
          if (!allStudyDocs.find(existing => existing.id === d.id)) {
            allStudyDocs.push(d);
          }
        });

        const studySubs = allStudyDocs.map(doc => {
          const data = doc.data();
          return {
            ...data,
            id: doc.id,
            familyId: data.familyId || familyId,
            childId: data.childId,
            childName: data.childName || data.studentName || '',
            startDate: data.startDate?.toDate?.() || new Date(data.startDate),
            endDate: data.endDate?.toDate?.() || new Date(data.endDate),
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
            updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
          } as StudyRoomEntry;
        });
        setStudySubscriptions(studySubs);

        const allTransportDocs = [...(await getDocs(query(collection(db, 'transportationSubscriptions'), where('familyId', '==', familyId)))).docs];
        const legacyTransport = (await getDocs(query(collection(db, 'transportationSubscriptions'), where('userId', '==', user.uid)))).docs;
        const transportByEmail = user.email ? (await getDocs(query(collection(db, 'transportationSubscriptions'), where('contactEmail', '==', user.email)))).docs : [];
        [...legacyTransport, ...transportByEmail].forEach(d => {
          if (!allTransportDocs.find(existing => existing.id === d.id)) {
            allTransportDocs.push(d);
          }
        });

        const transportSubs = allTransportDocs.map(doc => {
          const data = doc.data();
          return {
            ...data,
            id: doc.id,
            familyId: data.familyId || familyId,
            childId: data.childId,
            childName: data.childName || data.studentName || '',
            createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
            updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
          } as TransportationSubscription;
        });
        setTransportSubscriptions(transportSubs);
      };

      await fetchFamilyData();
      alert(`✓ Subscription linked to ${child.firstName} ${child.lastName}`);
    } catch (error: any) {
      console.error('Error linking subscription:', error);
      alert(`Error linking subscription: ${error.message}`);
    } finally {
      setLinkingSubscriptions(prev => {
        const next = new Set(prev);
        next.delete(subId);
        return next;
      });
    }
  };

  // Calculate total monthly cost (including unlinked subscriptions)
  const totalMonthly = Object.values(subscriptionsByChild).reduce((sum, { study, transport }) => {
    const studyTotal = study.reduce((s, sub) => s + sub.monthlyPrice, 0);
    const transportTotal = transport.reduce((t, sub) => t + sub.monthlyFee, 0);
    return sum + studyTotal + transportTotal;
  }, 0) +
    unlinkedStudy.reduce((sum, sub) => sum + sub.monthlyPrice, 0) +
    unlinkedTransport.reduce((sum, sub) => sum + sub.monthlyFee, 0);

  const activeSubscriptionsCount = studySubscriptions.length + transportSubscriptions.length;

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">Loading family dashboard...</div>
      </div>
    );
  }

  // This should not happen now since we auto-create, but keep as fallback
  if (!family && !isLoading) {
    return (
      <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
        <h2 className="text-xl font-bold mb-4">Loading Family Account...</h2>
        <p className="text-gray-600 mb-6">
          Setting up your family account...
        </p>
      </div>
    );
  }

  if (!family) {
    return null; // Still loading
  }

  return (
    <div className="space-y-6">
      {/* Family Overview Card */}
      <div className="bg-gradient-to-r from-blue-500 to-purple-600 text-white p-6 rounded-lg shadow-lg">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h1 className="text-2xl font-bold mb-1">Family Dashboard</h1>
            <p className="text-blue-100">{family.primaryContact.name}</p>
          </div>
          <button
            type="button"
            className="bg-white/10 px-4 py-2 rounded-lg text-sm opacity-70 cursor-not-allowed"
            title="Coming soon"
            disabled
          >
            Account Settings (Coming Soon)
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          <div className="bg-white/10 backdrop-blur rounded-lg p-4">
            <p className="text-sm opacity-90 mb-1">Total Monthly Cost</p>
            <p className="text-3xl font-bold">€{totalMonthly.toFixed(2)}</p>
          </div>
          <div className="bg-white/10 backdrop-blur rounded-lg p-4">
            <p className="text-sm opacity-90 mb-1">Children</p>
            <p className="text-3xl font-bold">{children.length}</p>
          </div>
          <div className="bg-white/10 backdrop-blur rounded-lg p-4">
            <p className="text-sm opacity-90 mb-1">Active Subscriptions</p>
            <p className="text-3xl font-bold">{activeSubscriptionsCount}</p>
          </div>
        </div>
      </div>

      {/* Children Cards */}
      <div>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">My Children</h2>
          <Link
            to="/client/children"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors text-sm"
          >
            + Add Child
          </Link>
        </div>

        {children.length === 0 ? (
          <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
            <p className="text-gray-500 mb-4">No children added yet.</p>
            <Link
              to="/client/children"
              className="inline-block bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700"
            >
              Add Your First Child
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {children.map(child => {
              const { study, transport, parties } = subscriptionsByChild[child.id] || {
                child,
                study: [],
                transport: [],
                parties: [],
              };

              const childTotal =
                study.reduce((s, sub) => s + sub.monthlyPrice, 0) +
                transport.reduce((t, sub) => t + sub.monthlyFee, 0);

              return (
                <div
                  key={child.id}
                  className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow"
                >
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="text-lg font-semibold">
                        {child.firstName} {child.lastName}
                      </h3>
                      <p className="text-sm text-gray-600">Age {child.age || 'N/A'}</p>
                      {child.schoolName && (
                        <p className="text-xs text-gray-500 mt-1">
                          {child.schoolName} · {child.schoolYear}
                        </p>
                      )}
                    </div>
                    <Link
                      to={`/client/children/${child.id}`}
                      className="text-blue-600 hover:underline text-sm"
                    >
                      View Details →
                    </Link>
                  </div>

                  {/* Services Summary */}
                  <div className="space-y-2 mb-4">
                    {study.length > 0 && (
                      <div className="flex items-center justify-between text-sm bg-blue-50 p-2 rounded">
                        <span className="flex items-center gap-2">
                          <span>📚</span> Study Room ({study.length})
                        </span>
                        <span className="font-medium">
                          €{study.reduce((s, sub) => s + sub.monthlyPrice, 0).toFixed(2)}/mo
                        </span>
                      </div>
                    )}
                    {transport.length > 0 && (
                      <div className="flex items-center justify-between text-sm bg-green-50 p-2 rounded">
                        <span className="flex items-center gap-2">
                          <span>🚌</span> Transport ({transport.length})
                        </span>
                        <span className="font-medium">
                          €{transport.reduce((t, sub) => t + sub.monthlyFee, 0).toFixed(2)}/mo
                        </span>
                      </div>
                    )}
                    {study.length === 0 && transport.length === 0 && (
                      <p className="text-sm text-gray-400 text-center py-2">No subscriptions</p>
                    )}
                  </div>

                  <div className="pt-4 border-t flex justify-between items-center">
                    <div>
                      <span className="font-bold text-lg">€{childTotal.toFixed(2)}/month</span>
                    </div>
                    <div className="flex gap-2">
                      <Link
                        to={`/client/children/${child.id}?section=subscriptions&action=add`}
                        className="text-blue-600 hover:underline text-sm"
                      >
                        + Add Service
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Unlinked Subscriptions Section */}
      {(unlinkedStudy.length > 0 || unlinkedTransport.length > 0) && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6">
          <div className="flex items-start gap-3 mb-4">
            <span className="text-2xl">⚠️</span>
            <div>
              <h3 className="text-lg font-semibold text-yellow-900 mb-1">
                Subscriptions Need Linking
              </h3>
              <p className="text-sm text-yellow-800">
                We found some subscriptions that aren't linked to a child yet. These may be from before you added your children.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {unlinkedStudy.map(sub => {
              const subscriptionName = (sub.childName || '').toLowerCase().trim();
              const matchedChildren = children.filter(child => {
                const childFullName = `${child.firstName} ${child.lastName}`.toLowerCase().trim();
                const nameParts = subscriptionName.split(/\s+/);
                const firstName = nameParts[0] || '';
                const lastName = nameParts.slice(1).join(' ') || '';
                return (
                  (firstName && child.firstName.toLowerCase().includes(firstName)) ||
                  (lastName && child.lastName.toLowerCase().includes(lastName)) ||
                  childFullName.includes(firstName) ||
                  subscriptionName.includes(child.firstName.toLowerCase())
                );
              });

              return (
                <div key={sub.id} className="bg-white p-4 rounded border border-yellow-300">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="font-medium">📚 Study Room - {getSubscriptionDisplayName(sub)}</div>
                      <div className="text-sm text-gray-600">
                        {sub.schoolName && `${sub.schoolName} · `}€{sub.monthlyPrice.toFixed(2)}/month
                      </div>
                    </div>
                    <span className="text-xs bg-yellow-200 text-yellow-800 px-2 py-1 rounded">
                      Not linked
                    </span>
                  </div>
                  <div className="mt-3 pt-3 border-t border-yellow-200">
                    <label className="block text-sm text-gray-700 mb-1">
                      Link to child:
                    </label>
                    <select
                      onChange={(e) => {
                        if (e.target.value) {
                          handleLinkSubscription(sub, e.target.value, 'study');
                        }
                      }}
                      disabled={linkingSubscriptions.has(sub.id)}
                      className="w-full px-3 py-2 border border-yellow-300 rounded-lg text-sm focus:ring-2 focus:ring-yellow-500"
                      defaultValue=""
                    >
                      <option value="">Select a child...</option>
                      {children.map(child => (
                        <option key={child.id} value={child.id}>
                          {child.firstName} {child.lastName}
                          {matchedChildren.find(c => c.id === child.id) && ' (likely match)'}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
            {unlinkedTransport.map(sub => {
              const subscriptionName = (sub.childName || '').toLowerCase().trim();
              const matchedChildren = children.filter(child => {
                const childFullName = `${child.firstName} ${child.lastName}`.toLowerCase().trim();
                const nameParts = subscriptionName.split(/\s+/);
                const firstName = nameParts[0] || '';
                const lastName = nameParts.slice(1).join(' ') || '';
                return (
                  (firstName && child.firstName.toLowerCase().includes(firstName)) ||
                  (lastName && child.lastName.toLowerCase().includes(lastName)) ||
                  childFullName.includes(firstName) ||
                  subscriptionName.includes(child.firstName.toLowerCase())
                );
              });

              return (
                <div key={sub.id} className="bg-white p-4 rounded border border-yellow-300">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="font-medium">🚌 Transport - {getSubscriptionDisplayName(sub)}</div>
                      <div className="text-sm text-gray-600">
                        €{sub.monthlyFee.toFixed(2)}/month
                      </div>
                    </div>
                    <span className="text-xs bg-yellow-200 text-yellow-800 px-2 py-1 rounded">
                      Not linked
                    </span>
                  </div>
                  <div className="mt-3 pt-3 border-t border-yellow-200">
                    <label className="block text-sm text-gray-700 mb-1">
                      Link to child:
                    </label>
                    <select
                      onChange={(e) => {
                        if (e.target.value) {
                          handleLinkSubscription(sub, e.target.value, 'transport');
                        }
                      }}
                      disabled={linkingSubscriptions.has(sub.id)}
                      className="w-full px-3 py-2 border border-yellow-300 rounded-lg text-sm focus:ring-2 focus:ring-yellow-500"
                      defaultValue=""
                    >
                      <option value="">Select a child...</option>
                      {children.map(child => (
                        <option key={child.id} value={child.id}>
                          {child.firstName} {child.lastName}
                          {matchedChildren.find(c => c.id === child.id) && ' (likely match)'}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 text-sm text-yellow-800">
            <p>
              💡 <strong>Tip:</strong> Select a child from the dropdown above to link each subscription. The system will suggest likely matches based on name similarity.
            </p>
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link
          to="/client/family/schedule"
          className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow text-left"
        >
          <div className="text-3xl mb-3">📅</div>
          <div className="font-semibold mb-1">Family Schedule</div>
          <div className="text-sm text-gray-600">View all schedules in one place</div>
        </Link>

        <Link
          to="/client/family/invoices"
          className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow text-left"
        >
          <div className="text-3xl mb-3">📄</div>
          <div className="font-semibold mb-1">Invoices & Billing</div>
          <div className="text-sm text-gray-600">Single invoice for all services</div>
        </Link>

        <Link
          to="/client/family/payments"
          className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow text-left"
        >
          <div className="text-3xl mb-3">💳</div>
          <div className="font-semibold mb-1">Payment History</div>
          <div className="text-sm text-gray-600">Track all payments</div>
        </Link>
      </div>
    </div>
  );
}

