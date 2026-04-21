import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { StudyRoomEntry, DaySelection } from '@shared/models';
import { format } from 'date-fns';

const WEEKDAYS = [
  { label: 'Monday', value: 'monday' },
  { label: 'Tuesday', value: 'tuesday' },
  { label: 'Wednesday', value: 'wednesday' },
  { label: 'Thursday', value: 'thursday' },
  { label: 'Friday', value: 'friday' },
];

const TIME_SLOTS = [
  '08:00', '08:30', '09:00', '09:30', '10:00', '10:30',
  '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
  '17:00', '17:30', '18:00'
];

export default function StudySubscriptionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [subscription, setSubscription] = useState<StudyRoomEntry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<StudyRoomEntry>>({});
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
      const docRef = doc(db, 'studyroom', id);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        const sub = {
          ...data,
          id: docSnap.id,
          startDate: data.startDate?.toDate?.() || new Date(data.startDate),
          endDate: data.endDate?.toDate?.() || new Date(data.endDate),
          createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
          updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
        } as StudyRoomEntry;
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

      await updateDoc(doc(db, 'studyroom', id), updates);
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

  const addDay = () => {
    setEditData(prev => ({
      ...prev,
      days: [...(prev.days || subscription?.days || []), { day: 'monday', hour: '08:00', transport: false }],
    }));
  };

  const removeDay = (index: number) => {
    setEditData(prev => ({
      ...prev,
      days: (prev.days || subscription?.days || []).filter((_, i) => i !== index),
    }));
  };

  const updateDay = (index: number, field: keyof DaySelection, value: any) => {
    setEditData(prev => {
      const days = [...(prev.days || subscription?.days || [])];
      days[index] = { ...days[index], [field]: value };
      return { ...prev, days };
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
  const days = displayData.days || [];

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
          <h1 className="text-2xl font-bold">Study Room Subscription</h1>
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
                  displayData.status === 'confirmed' ? 'bg-green-100 text-green-800' :
                  displayData.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                  'bg-gray-100 text-gray-800'
                }`}>
                  {displayData.status}
                </span>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-1">School</p>
                <p className="font-medium">{displayData.schoolName}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-1">School Year</p>
                <p className="font-medium">{displayData.schoolYear}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-1">Start Date</p>
                <p className="font-medium">
                  {displayData.startDate ? format(displayData.startDate as Date, 'MMM d, yyyy') : 'N/A'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-600 mb-1">End Date</p>
                <p className="font-medium">
                  {displayData.endDate ? format(displayData.endDate as Date, 'MMM d, yyyy') : 'N/A'}
                </p>
              </div>
              <div className="col-span-2">
                <p className="text-sm text-gray-600 mb-1">Monthly Price</p>
                <p className="font-medium text-lg">€{displayData.monthlyPrice?.toFixed(2) || '0.00'}</p>
              </div>
            </div>
          </div>

          {/* Schedule */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold">Schedule</h2>
              {isEditing && (
                <button
                  onClick={addDay}
                  className="text-sm text-blue-600 hover:underline"
                >
                  + Add Day
                </button>
              )}
            </div>
            
            {days.length === 0 ? (
              <p className="text-gray-500 text-center py-4">No days selected</p>
            ) : (
              <div className="space-y-2">
                {days.map((day, index) => (
                  <div key={index} className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
                    {isEditing ? (
                      <>
                        <select
                          value={day.day}
                          onChange={(e) => updateDay(index, 'day', e.target.value)}
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        >
                          {WEEKDAYS.map(wd => (
                            <option key={wd.value} value={wd.value}>{wd.label}</option>
                          ))}
                        </select>
                        <select
                          value={day.hour}
                          onChange={(e) => updateDay(index, 'hour', e.target.value)}
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        >
                          {TIME_SLOTS.map(time => (
                            <option key={time} value={time}>{time}</option>
                          ))}
                        </select>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={day.transport || false}
                            onChange={(e) => updateDay(index, 'transport', e.target.checked)}
                            className="rounded"
                          />
                          Transport
                        </label>
                        <button
                          onClick={() => removeDay(index)}
                          className="text-red-600 hover:text-red-800 text-sm"
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 font-medium">{WEEKDAYS.find(w => w.value === day.day)?.label || day.day}</span>
                        <span className="flex-1 text-gray-600">{day.hour}</span>
                        {day.transport && (
                          <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                            Transport
                          </span>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Notes */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-xl font-semibold mb-4">Notes</h2>
            {isEditing ? (
              <textarea
                value={editData.note || ''}
                onChange={(e) => setEditData({ ...editData, note: e.target.value })}
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                placeholder="Add any notes or special instructions..."
              />
            ) : (
              <p className="text-gray-700">{subscription.note || 'No notes'}</p>
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
