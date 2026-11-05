import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import { Child, StudyRoomEntry, TransportationSubscription, Booking, Family } from '@shared/models';
import { format } from 'date-fns';
import { calculateAge } from '../../lib/utils';
import { familyService } from '../../services/familyService';

export default function ChildDetailPage() {
  const { childId } = useParams<{ childId: string }>();
  const user = useUser();
  const navigate = useNavigate();
  const location = useLocation();
  
  const [child, setChild] = useState<Child | null>(null);
  const [family, setFamily] = useState<Family | null>(null);
  const [studySubscriptions, setStudySubscriptions] = useState<StudyRoomEntry[]>([]);
  const [transportSubscriptions, setTransportSubscriptions] = useState<TransportationSubscription[]>([]);
  const [partyBookings, setPartyBookings] = useState<Booking[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editFormData, setEditFormData] = useState<Partial<Child>>({});
  const [highlightSubscriptions, setHighlightSubscriptions] = useState(false);

  const subscriptionsSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (childId && user) {
      fetchChildData();
    }
  }, [childId, user]);

  useEffect(() => {
    if (isLoading) return;

    const params = new URLSearchParams(location.search);
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (params.get('section') === 'subscriptions' && subscriptionsSectionRef.current) {
      subscriptionsSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });

      if (params.get('action') === 'add') {
        setHighlightSubscriptions(true);
        timer = setTimeout(() => setHighlightSubscriptions(false), 2000);
      }
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [isLoading, location.search]);

  const fetchChildData = async () => {
    if (!childId || !user) return;
    setIsLoading(true);
    try {
      const [childData, family] = await Promise.all([
        familyService.getChild(childId),
        familyService.getOrCreateFamily(
          user.uid,
          user.name || user.email?.split('@')[0] || 'Utilizador',
          user.email || ''
        ),
      ]);

      if (!childData) {
        navigate('/client/children');
        return;
      }

      if (childData.familyId !== family.id) {
        navigate('/client/children');
        return;
      }

      setFamily(family);
      setChild(childData);
      setEditFormData(childData);
    } catch (error) {
      console.error('Error fetching child/family data:', error);
    } finally {
      setIsLoading(false);
    }

    // Load subscriptions separately — failure here shouldn't break the page
    try {
      const { study, transport, parties } = await familyService.getChildSubscriptions(childId, user.uid);
      setStudySubscriptions(study);
      setTransportSubscriptions(transport);
      setPartyBookings(parties);
    } catch (error) {
      console.error('Error fetching subscriptions:', error);
    }
  };

  const handleSave = async () => {
    if (!child || !childId) return;
    try {
      await familyService.updateChild(childId, editFormData);
      await fetchChildData();
      setIsEditing(false);
      setSaveMessage({ type: 'success', text: 'Dados da criança actualizados.' });
      setTimeout(() => setSaveMessage(null), 4000);
    } catch (error) {
      console.error('Error updating child:', error);
      setSaveMessage({ type: 'error', text: 'Erro ao guardar. Tenta novamente.' });
    }
  };

  const totalMonthlyCost = 
    studySubscriptions.reduce((sum, sub) => sum + sub.monthlyPrice, 0) +
    transportSubscriptions.reduce((sum, sub) => sum + sub.monthlyFee, 0);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">Loading child information...</div>
      </div>
    );
  }

  if (!child) {
    return (
      <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
        <p className="text-gray-500 mb-4">Child not found.</p>
        <Link to="/client/children" className="text-blue-600 hover:underline">
          ← Back to Children
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {saveMessage && (
        <div className={`px-4 py-3 rounded-lg text-sm font-medium ${saveMessage.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {saveMessage.text}
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link
            to="/client/children"
            className="text-blue-600 hover:underline text-sm mb-2 inline-block"
          >
            ← As minhas crianças
          </Link>
          <h1 className="text-2xl font-bold">
            {child.firstName} {child.lastName}
          </h1>
        </div>
        <button
          onClick={() => setIsEditing(!isEditing)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          {isEditing ? 'Cancelar' : 'Editar'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Child Information */}
        <div className="lg:col-span-2 space-y-6">
          {/* Basic Information */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-xl font-semibold mb-4">Basic Information</h2>
            
            {isEditing ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      First Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={editFormData.firstName || ''}
                      onChange={(e) => setEditFormData({ ...editFormData, firstName: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Last Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={editFormData.lastName || ''}
                      onChange={(e) => setEditFormData({ ...editFormData, lastName: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Date of Birth *
                  </label>
                  <input
                    type="date"
                    required
                    value={(() => {
                      const d = editFormData.dateOfBirth as Date | undefined;
                      if (!d || isNaN(d.getTime())) return '';
                      try { return format(d, 'yyyy-MM-dd'); } catch { return ''; }
                    })()}
                    onChange={(e) => {
                      const newDate = new Date(e.target.value + 'T12:00:00');
                      setEditFormData({
                        ...editFormData,
                        dateOfBirth: newDate,
                        age: calculateAge(newDate),
                      });
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      School Name
                    </label>
                    <input
                      type="text"
                      value={editFormData.schoolName || ''}
                      onChange={(e) => setEditFormData({ ...editFormData, schoolName: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      School Year
                    </label>
                    <input
                      type="text"
                      value={editFormData.schoolYear || ''}
                      onChange={(e) => setEditFormData({ ...editFormData, schoolYear: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Medical Notes
                  </label>
                  <textarea
                    value={editFormData.medicalNotes || ''}
                    onChange={(e) => setEditFormData({ ...editFormData, medicalNotes: e.target.value })}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Notes
                  </label>
                  <textarea
                    value={editFormData.notes || ''}
                    onChange={(e) => setEditFormData({ ...editFormData, notes: e.target.value })}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <button
                  onClick={handleSave}
                  className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700"
                >
                  Save Changes
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-600 mb-1">Age</p>
                  <p className="font-medium">{child.age || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 mb-1">Date of Birth</p>
                  <p className="font-medium">
                    {child.dateOfBirth ? format(child.dateOfBirth as Date, 'MMMM d, yyyy') : 'N/A'}
                  </p>
                </div>
                {child.schoolName && (
                  <div>
                    <p className="text-sm text-gray-600 mb-1">School</p>
                    <p className="font-medium">{child.schoolName}</p>
                  </div>
                )}
                {child.schoolYear && (
                  <div>
                    <p className="text-sm text-gray-600 mb-1">School Year</p>
                    <p className="font-medium">{child.schoolYear}</p>
                  </div>
                )}
                {child.medicalNotes && (
                  <div className="col-span-2">
                    <p className="text-sm text-gray-600 mb-1">Medical Notes</p>
                    <p className="font-medium">{child.medicalNotes}</p>
                  </div>
                )}
                {child.notes && (
                  <div className="col-span-2">
                    <p className="text-sm text-gray-600 mb-1">Notes</p>
                    <p className="font-medium">{child.notes}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Subscriptions */}
          <div
            ref={subscriptionsSectionRef}
            className={`bg-white p-6 rounded-lg shadow-sm border border-gray-200 transition ${
              highlightSubscriptions ? 'ring-2 ring-blue-400' : ''
            }`}
          >
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold">Subscriptions</h2>
              <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 ml-3">
                <Link
                  to={`/client/enroll/transport?childId=${childId}`}
                  className="text-blue-600 hover:underline text-sm whitespace-nowrap"
                >
                  + Transporte
                </Link>
                <Link
                  to={`/client/enroll/study?childId=${childId}`}
                  className="text-blue-600 hover:underline text-sm whitespace-nowrap"
                >
                  + Sala de Estudo
                </Link>
              </div>
            </div>

            {studySubscriptions.length === 0 && transportSubscriptions.length === 0 ? (
              <p className="text-gray-500 text-center py-4">No subscriptions yet.</p>
            ) : (
              <div className="space-y-3">
                {studySubscriptions.map(sub => (
                  <Link
                    key={sub.id}
                    to={`/client/study/${sub.id}`}
                    className="block bg-blue-50 p-4 rounded-lg hover:bg-blue-100 transition-colors"
                  >
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="font-medium text-blue-900">📚 Sala de Estudo</div>
                        <div className="text-sm text-blue-700">
                          €{sub.monthlyPrice.toFixed(2)}/mês
                        </div>
                      </div>
                      <span className={`text-xs px-2 py-1 rounded ${
                        sub.status === 'active' ? 'bg-green-100 text-green-800' :
                        sub.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                        {sub.status}
                      </span>
                    </div>
                  </Link>
                ))}
                {transportSubscriptions.map(sub => (
                  <Link
                    key={sub.id}
                    to={`/client/transport/${sub.id}`}
                    className="block bg-green-50 p-4 rounded-lg hover:bg-green-100 transition-colors"
                  >
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="font-medium text-green-900">🚌 Transporte</div>
                        <div className="text-sm text-green-700">
                          €{sub.monthlyFee.toFixed(2)}/mês
                        </div>
                      </div>
                      <span className={`text-xs px-2 py-1 rounded ${
                        sub.status === 'active' ? 'bg-green-100 text-green-800' :
                        sub.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                        {sub.status}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Party Bookings */}
          {partyBookings.length > 0 && (
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
              <h2 className="text-xl font-semibold mb-4">Party Bookings</h2>
              <div className="space-y-2">
                {partyBookings.map(booking => (
                  <div key={booking.id} className="bg-purple-50 p-3 rounded-lg">
                    <div className="font-medium text-purple-900">🎉 Party</div>
                    <div className="text-sm text-purple-700">
                      {booking.date} at {booking.time}
                    </div>
                    <span className={`text-xs px-2 py-1 rounded mt-1 inline-block ${
                      booking.status === 'confirmed' ? 'bg-green-100 text-green-800' :
                      booking.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {booking.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Column - Summary */}
        <div className="space-y-6">
          {/* Monthly Cost Summary */}
          <div className="bg-gradient-to-r from-blue-500 to-purple-600 text-white p-6 rounded-lg shadow-lg">
            <h3 className="text-lg font-semibold mb-4">Monthly Cost</h3>
            <div className="text-3xl font-bold">€{totalMonthlyCost.toFixed(2)}</div>
            <div className="text-sm opacity-90 mt-2">
              {studySubscriptions.length + transportSubscriptions.length} active subscription(s)
            </div>
          </div>

          {/* Quick Actions */}
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h3 className="text-lg font-semibold mb-4">Quick Actions</h3>
            <div className="space-y-2">
              <Link
                to={`/client/calendar?child=${childId}`}
                className="block w-full bg-purple-50 text-purple-600 py-2 px-4 rounded text-center hover:bg-purple-100 transition-colors"
              >
                📅 Manage Events Calendar
              </Link>
              <Link
                to="/client/family/schedule"
                className="block w-full bg-green-50 text-green-600 py-2 px-4 rounded text-center hover:bg-green-100 transition-colors"
              >
                📋 View Family Schedule
              </Link>
              <Link
                to={`/client/children/${childId}/subscriptions`}
                className="block w-full bg-blue-50 text-blue-600 py-2 px-4 rounded text-center hover:bg-blue-100 transition-colors"
              >
                Manage Subscriptions
              </Link>
              <Link
                to="/client/children"
                className="block w-full bg-gray-50 text-gray-600 py-2 px-4 rounded text-center hover:bg-gray-100 transition-colors"
              >
                Back to All Children
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

