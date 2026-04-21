import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { TransportationSubscription, SubscriptionSchedule } from '@shared/models';
import { format } from 'date-fns';

const WEEKDAYS = [
  { label: 'Monday', value: 'monday' },
  { label: 'Tuesday', value: 'tuesday' },
  { label: 'Wednesday', value: 'wednesday' },
  { label: 'Thursday', value: 'thursday' },
  { label: 'Friday', value: 'friday' },
  { label: 'Saturday', value: 'saturday' },
  { label: 'Sunday', value: 'sunday' },
];

const TIME_SLOTS = [
  '07:00', '07:15', '07:30', '07:45',
  '08:00', '08:15', '08:30', '08:45',
  '09:00', '09:15', '09:30', '09:45',
  '10:00', '10:15', '10:30', '10:45',
  '11:00', '11:15', '11:30', '11:45',
  '12:00', '12:15', '12:30', '12:45',
  '13:00', '13:15', '13:30', '13:45',
  '14:00', '14:15', '14:30', '14:45',
  '15:00', '15:15', '15:30', '15:45',
  '16:00', '16:15', '16:30', '16:45',
  '17:00', '17:15', '17:30', '17:45',
  '18:00', '18:15', '18:30', '18:45',
  '19:00'
];

export default function TransportSubscriptionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [subscription, setSubscription] = useState<TransportationSubscription | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<TransportationSubscription>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (id) {
      fetchSubscription();
    }
  }, [id]);

  const fetchSubscription = async () => {
    if (!id) return;
    setIsLoading(true);
    try {
      const docRef = doc(db, 'transportationSubscriptions', id);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        const sub = {
          ...data,
          id: docSnap.id,
          createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
          updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
        } as TransportationSubscription;
        setSubscription(sub);
        setEditData(sub);
      }
    } catch (error) {
      console.error('Error fetching subscription:', error);
      alert('Error loading subscription details.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!subscription || !id) return;

    setSaving(true);
    try {
      const updates: any = {
        ...editData,
        updatedAt: new Date(),
      };

      // Remove undefined values
      Object.keys(updates).forEach(key => {
        if (updates[key] === undefined) {
          delete updates[key];
        }
      });

      await updateDoc(doc(db, 'transportationSubscriptions', id), updates);
      await fetchSubscription();
      setIsEditing(false);
      alert('Subscription updated successfully!');
    } catch (error: any) {
      console.error('Error updating subscription:', error);
      alert(`Error updating subscription: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const addScheduleItem = () => {
    setEditData(prev => ({
      ...prev,
      schedule: [...(prev.schedule || subscription?.schedule || []), {
        dayOfWeek: 'monday',
        pickupTime: '08:00',
        pickupLocation: '',
        dropoffLocation: '',
      }],
    }));
  };

  const removeScheduleItem = (index: number) => {
    setEditData(prev => ({
      ...prev,
      schedule: (prev.schedule || subscription?.schedule || []).filter((_, i) => i !== index),
    }));
  };

  const updateScheduleItem = (index: number, field: keyof SubscriptionSchedule, value: any) => {
    setEditData(prev => {
      const schedule = [...(prev.schedule || subscription?.schedule || [])];
      schedule[index] = { ...schedule[index], [field]: value };
      return { ...prev, schedule };
    });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">Loading subscription details...</div>
      </div>
    );
  }

  if (!subscription) {
    return (
      <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
        <p className="text-gray-500 mb-4">Subscription not found.</p>
        <Link to="/client" className="text-blue-600 hover:underline">
          ← Back to Dashboard
        </Link>
      </div>
    );
  }

  const displayData = isEditing ? editData : subscription;
  const schedule = displayData.schedule || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link 
            to={subscription.childId ? `/client/children/${subscription.childId}` : '/client'} 
            className="text-blue-600 hover:underline text-sm mb-2 inline-block"
          >
            ← Back
          </Link>
          <h1 className="text-2xl font-bold">Transport Subscription</h1>
        </div>
        <button
          onClick={() => isEditing ? setIsEditing(false) : setIsEditing(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          {isEditing ? 'Cancel' : 'Edit'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column - Details */}
        <div className="space-y-6">
          {/* Basic Information */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-xl font-semibold mb-4">Basic Information</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-600 mb-1">Student</p>
                <p className="font-medium">{displayData.childName || subscription.childName}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-1">Status</p>
                <span className={`inline-block px-2 py-1 rounded text-xs ${
                  displayData.status === 'active' ? 'bg-green-100 text-green-800' :
                  displayData.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                  'bg-gray-100 text-gray-800'
                }`}>
                  {displayData.status}
                </span>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-1">Start Date</p>
                <p className="font-medium">
                  {displayData.startDate ? format(new Date(displayData.startDate), 'MMM d, yyyy') : 'N/A'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-1">End Date</p>
                <p className="font-medium">
                  {displayData.endDate ? format(new Date(displayData.endDate), 'MMM d, yyyy') : 'N/A'}
                </p>
              </div>
              <div className="col-span-2">
                <p className="text-sm text-gray-600 mb-1">Monthly Fee</p>
                <p className="font-medium text-lg">€{displayData.monthlyFee?.toFixed(2) || '0.00'}</p>
              </div>
              {displayData.ridesRemaining !== undefined && (
                <div className="col-span-2">
                  <p className="text-sm text-gray-600 mb-1">Rides Remaining</p>
                  <p className="font-medium">{displayData.ridesRemaining}</p>
                </div>
              )}
            </div>
          </div>

          {/* Contact Information */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-xl font-semibold mb-4">Contact Information</h2>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <p className="text-sm text-gray-600 mb-1">Email</p>
                {isEditing ? (
                  <input
                    type="email"
                    value={editData.contactEmail || ''}
                    onChange={(e) => setEditData({ ...editData, contactEmail: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                ) : (
                  <p className="font-medium">{displayData.contactEmail}</p>
                )}
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-1">Mobile</p>
                {isEditing ? (
                  <input
                    type="tel"
                    value={editData.contactMobile || ''}
                    onChange={(e) => setEditData({ ...editData, contactMobile: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                ) : (
                  <p className="font-medium">{displayData.contactMobile}</p>
                )}
              </div>
            </div>
          </div>

          {/* Schedule */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold">Schedule</h2>
              {isEditing && (
                <button
                  onClick={addScheduleItem}
                  className="text-sm text-blue-600 hover:underline"
                >
                  + Add Schedule
                </button>
              )}
            </div>
            
            {schedule.length === 0 ? (
              <p className="text-gray-500 text-center py-4">No schedule defined</p>
            ) : (
              <div className="space-y-3">
                {schedule.map((item, index) => (
                  <div key={index} className="p-4 bg-gray-50 rounded-lg">
                    {isEditing ? (
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">Day</label>
                            <select
                              value={item.dayOfWeek}
                              onChange={(e) => updateScheduleItem(index, 'dayOfWeek', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                            >
                              {WEEKDAYS.map(wd => (
                                <option key={wd.value} value={wd.value}>{wd.label}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">Pickup Time</label>
                            <select
                              value={item.pickupTime}
                              onChange={(e) => updateScheduleItem(index, 'pickupTime', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                            >
                              {TIME_SLOTS.map(time => (
                                <option key={time} value={time}>{time}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Pickup Location</label>
                          <input
                            type="text"
                            value={item.pickupLocation}
                            onChange={(e) => updateScheduleItem(index, 'pickupLocation', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                            placeholder="Address or location name"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Drop-off Location</label>
                          <input
                            type="text"
                            value={item.dropoffLocation}
                            onChange={(e) => updateScheduleItem(index, 'dropoffLocation', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                            placeholder="Address or location name"
                          />
                        </div>
                        <button
                          onClick={() => removeScheduleItem(index)}
                          className="text-red-600 hover:text-red-800 text-sm"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-medium">
                            {WEEKDAYS.find(w => w.value === item.dayOfWeek)?.label || item.dayOfWeek}
                          </span>
                          <span className="text-sm text-gray-600">{item.pickupTime}</span>
                        </div>
                        <div className="text-sm text-gray-600">
                          <p>📍 Pickup: {item.pickupLocation}</p>
                          <p>📍 Drop-off: {item.dropoffLocation}</p>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column - Actions */}
        <div className="space-y-6">
          {isEditing && (
            <div className="bg-blue-50 border border-blue-200 p-6 rounded-lg">
              <h3 className="font-semibold text-blue-900 mb-2">Save Changes</h3>
              <p className="text-sm text-blue-800 mb-4">
                Review your changes and click Save to update your subscription.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  onClick={() => {
                    setIsEditing(false);
                    setEditData(subscription);
                  }}
                  className="bg-gray-200 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h3 className="text-lg font-semibold mb-4">Quick Actions</h3>
            <div className="space-y-2">
              {subscription.childId && (
                <Link
                  to={`/client/children/${subscription.childId}`}
                  className="block w-full bg-blue-50 text-blue-600 py-2 px-4 rounded text-center hover:bg-blue-100 transition-colors"
                >
                  View Child Profile
                </Link>
              )}
              <Link
                to="/client"
                className="block w-full bg-gray-50 text-gray-600 py-2 px-4 rounded text-center hover:bg-gray-100 transition-colors"
              >
                Back to Dashboard
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
