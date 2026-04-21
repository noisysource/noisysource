import { useState, useEffect } from 'react';
import { useUser } from '@shared/hooks';
import { db } from '../../lib/firebase';
import { collection, getDocs, query, where, doc, getDoc, addDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { Family, Child } from '@shared/models';
import { Link, useNavigate } from 'react-router-dom';
import { calculateAge } from '../../lib/utils';

export default function ChildManagementPage() {
  const user = useUser();
  const [family, setFamily] = useState<Family | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [existingSubscriptions, setExistingSubscriptions] = useState<Array<{ studentName: string; schoolName?: string; schoolYear?: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (user) {
      fetchFamilyAndChildren();
      fetchExistingSubscriptions();
    }
  }, [user]);

  // Fetch existing subscriptions to suggest children from
  const fetchExistingSubscriptions = async () => {
    if (!user) return;
    
    try {
      // Check for existing study room subscriptions with userId (legacy data)
      const studyQuery = query(
        collection(db, 'studyroom'),
        where('userId', '==', user.uid)
      );
      const studySnapshot = await getDocs(studyQuery);
      
      // Check for transport subscriptions
      const transportQuery = query(
        collection(db, 'transportationSubscriptions'),
        where('userId', '==', user.uid)
      );
      const transportSnapshot = await getDocs(transportQuery);
      
      // Also check by email
      let transportByEmail = { docs: [] };
      if (user.email) {
        const transportEmailQuery = query(
          collection(db, 'transportationSubscriptions'),
          where('contactEmail', '==', user.email)
        );
        transportByEmail = await getDocs(transportEmailQuery);
      }

      const subscriptions: Array<{ studentName: string; schoolName?: string; schoolYear?: string }> = [];
      
      // Extract unique student names from study subscriptions
      studySnapshot.docs.forEach(doc => {
        const data = doc.data();
        if (data.studentName && !subscriptions.find(s => s.studentName === data.studentName)) {
          subscriptions.push({
            studentName: data.studentName,
            schoolName: data.schoolName,
            schoolYear: data.schoolYear,
          });
        }
      });
      
      // Extract unique student names from transport subscriptions
      [...transportSnapshot.docs, ...transportByEmail.docs].forEach(doc => {
        const data = doc.data();
        if (data.studentName && !subscriptions.find(s => s.studentName === data.studentName)) {
          subscriptions.push({
            studentName: data.studentName,
          });
        }
      });

      setExistingSubscriptions(subscriptions);
    } catch (error) {
      console.error('Error fetching existing subscriptions:', error);
    }
  };

  const fetchFamilyAndChildren = async () => {
    setIsLoading(true);
    try {
      // Find family
      const familiesQuery = query(
        collection(db, 'families'),
        where('primaryContact.userId', '==', user.uid)
      );
      const familiesSnapshot = await getDocs(familiesQuery);

      if (familiesSnapshot.empty) {
        // Auto-create family if it doesn't exist
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
        setChildren([]);
        setIsLoading(false);
        return;
      }

      if (!familiesSnapshot.empty) {
        const familyData = {
          ...familiesSnapshot.docs[0].data(),
          id: familiesSnapshot.docs[0].id,
          createdAt: familiesSnapshot.docs[0].data().createdAt?.toDate?.() || new Date(),
          updatedAt: familiesSnapshot.docs[0].data().updatedAt?.toDate?.() || new Date(),
        } as Family;
        setFamily(familyData);

        // Fetch children (including inactive ones - we'll filter them in the UI)
        const childrenQuery = query(
          collection(db, 'children'),
          where('familyId', '==', familyData.id)
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
      }
    } catch (error) {
      console.error('Error fetching children:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddChild = async (childData: Omit<Child, 'id' | 'createdAt' | 'updatedAt' | 'familyId'>) => {
    if (!family) return;

    try {
      // Remove undefined values (Firestore doesn't allow undefined)
      const cleanChildData: any = {
        firstName: childData.firstName,
        lastName: childData.lastName,
        dateOfBirth: childData.dateOfBirth,
        age: childData.age,
        familyId: family.id,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      
      // Only add optional fields if they have values
      if (childData.schoolName) cleanChildData.schoolName = childData.schoolName;
      if (childData.schoolYear) cleanChildData.schoolYear = childData.schoolYear;
      if (childData.schoolGrade) cleanChildData.schoolGrade = childData.schoolGrade;
      if (childData.contactPhone) cleanChildData.contactPhone = childData.contactPhone;
      if (childData.contactEmail) cleanChildData.contactEmail = childData.contactEmail;
      if (childData.medicalNotes) cleanChildData.medicalNotes = childData.medicalNotes;
      if (childData.allergies && childData.allergies.length > 0) cleanChildData.allergies = childData.allergies;
      if (childData.notes) cleanChildData.notes = childData.notes;

      await addDoc(collection(db, 'children'), cleanChildData);
      await fetchFamilyAndChildren();
      setShowAddForm(false);
    } catch (error) {
      console.error('Error adding child:', error);
      alert('Error adding child. Please try again.');
    }
  };

  const handleDeleteChild = async (child: Child) => {
    // Check for active subscriptions
    try {
      const [studySubs, transportSubs, bookings] = await Promise.all([
        getDocs(query(collection(db, 'studyroom'), where('childId', '==', child.id))),
        getDocs(query(collection(db, 'transportationSubscriptions'), where('childId', '==', child.id))),
        getDocs(query(collection(db, 'bookings'), where('childId', '==', child.id))),
      ]);

      const totalSubscriptions = studySubs.docs.length + transportSubs.docs.length + bookings.docs.length;

      if (totalSubscriptions > 0) {
        const confirmMessage = `⚠️ This child has ${totalSubscriptions} subscription(s) or booking(s) linked to them.\n\n` +
          `Recommended: Deactivate the child (keeps subscriptions but hides from active list)\n\n` +
          `Alternative: Delete permanently (you'll need to update subscriptions manually)`;
        
        const choice = window.confirm(confirmMessage + '\n\nClick OK to DEACTIVATE, or Cancel to DELETE PERMANENTLY');
        
        if (choice) {
          // Soft delete - set status to inactive
          await updateDoc(doc(db, 'children', child.id), {
            status: 'inactive',
            updatedAt: new Date(),
          });
          alert('Child has been deactivated. Subscriptions are still linked but the child is now inactive.');
        } else {
          // Hard delete - user confirmed
          if (window.confirm(`Are you absolutely sure you want to permanently delete ${child.firstName} ${child.lastName}? This cannot be undone!`)) {
            await deleteDoc(doc(db, 'children', child.id));
            alert('Child has been permanently deleted. You may need to update linked subscriptions manually.');
          } else {
            return; // User cancelled
          }
        }
      } else {
        // No subscriptions - safe to delete
        const confirmDelete = window.confirm(
          `Are you sure you want to delete ${child.firstName} ${child.lastName}? This action cannot be undone.`
        );
        
        if (confirmDelete) {
          await deleteDoc(doc(db, 'children', child.id));
        } else {
          return; // User cancelled
        }
      }

      await fetchFamilyAndChildren();
    } catch (error) {
      console.error('Error deleting child:', error);
      alert('Error deleting child. Please try again.');
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!family) {
    return (
      <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
        <p className="text-gray-500 mb-4">Family account not found.</p>
        <Link to="/client" className="text-blue-600 hover:underline">Go to Dashboard</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Manage Children</h1>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          {showAddForm ? 'Cancel' : '+ Add Child'}
        </button>
      </div>

      {showAddForm && (
        <AddChildForm
          onSave={handleAddChild}
          onCancel={() => setShowAddForm(false)}
          suggestedChildren={existingSubscriptions}
        />
      )}

      {/* Show suggestions from existing subscriptions */}
      {existingSubscriptions.length > 0 && children.length === 0 && !showAddForm && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-2">
            💡 Found existing subscriptions
          </h3>
          <p className="text-sm text-blue-700 mb-4">
            We found the following students in your existing subscriptions. Would you like to add them as children?
          </p>
          <div className="space-y-2">
            {existingSubscriptions.map((sub, index) => (
              <div key={index} className="bg-white p-3 rounded border border-blue-200 flex justify-between items-center">
                <div>
                  <p className="font-medium">{sub.studentName}</p>
                  {sub.schoolName && (
                    <p className="text-sm text-gray-600">{sub.schoolName} · {sub.schoolYear}</p>
                  )}
                </div>
                <button
                  onClick={() => {
                    setShowAddForm(true);
                    // The form will auto-fill if there's only one suggestion, or user can fill manually
                  }}
                  className="bg-blue-600 text-white px-4 py-1 rounded text-sm hover:bg-blue-700"
                >
                  Add as Child
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {children
          .filter(child => child.status !== 'inactive') // Only show active children by default
          .map(child => (
          <div
            key={child.id}
            className="bg-white p-6 rounded-lg shadow-sm border border-gray-200"
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
                {child.status === 'inactive' && (
                  <span className="inline-block mt-2 px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">
                    Inactive
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Link
                  to={`/client/children/${child.id}`}
                  className="text-blue-600 hover:underline text-sm"
                >
                  Edit →
                </Link>
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <Link
                to={`/client/children/${child.id}?section=subscriptions`}
                className="flex-1 bg-blue-50 text-blue-600 py-2 px-4 rounded text-center text-sm hover:bg-blue-100"
              >
                View Subscriptions
              </Link>
              <Link
                to={`/client/children/${child.id}/calendar`}
                className="flex-1 bg-green-50 text-green-600 py-2 px-4 rounded text-center text-sm hover:bg-green-100"
              >
                View Schedule
              </Link>
            </div>
            <div className="flex gap-2 mt-2">
              <Link
                to={`/client/children/${child.id}/calendar`}
                className="flex-1 bg-purple-50 text-purple-700 py-2 px-4 rounded text-center text-sm font-medium hover:bg-purple-100 border border-purple-200"
              >
                📅 Manage Events Calendar
              </Link>
            </div>

            <div className="mt-4 pt-4 border-t border-gray-200">
              <button
                onClick={() => handleDeleteChild(child)}
                className="w-full bg-red-50 text-red-600 py-2 px-4 rounded text-sm hover:bg-red-100 transition-colors"
              >
                Remove Child
              </button>
            </div>
          </div>
        ))}
      </div>

      {children.length === 0 && !showAddForm && (
        <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200 text-center">
          <p className="text-gray-500 mb-4">No children added yet.</p>
          <button
            onClick={() => setShowAddForm(true)}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700"
          >
            Add Your First Child
          </button>
        </div>
      )}
    </div>
  );
}

interface AddChildFormProps {
  onSave: (childData: Omit<Child, 'id' | 'createdAt' | 'updatedAt' | 'familyId'>) => void;
  onCancel: () => void;
  suggestedChildren?: Array<{ studentName: string; schoolName?: string; schoolYear?: string }>;
}

function AddChildForm({ onSave, onCancel, suggestedChildren = [] }: AddChildFormProps) {
  const [selectedSuggestion, setSelectedSuggestion] = useState<number | null>(null);
  
  // Initialize form with first suggestion if available
  const initialFormData = suggestedChildren.length > 0 && selectedSuggestion === null
    ? (() => {
        const suggestion = suggestedChildren[0];
        const nameParts = suggestion.studentName.split(' ');
        return {
          firstName: nameParts[0] || '',
          lastName: nameParts.slice(1).join(' ') || '',
          dateOfBirth: '',
          schoolName: suggestion.schoolName || '',
          schoolYear: suggestion.schoolYear || '',
          schoolGrade: '',
          contactPhone: '',
          contactEmail: '',
          medicalNotes: '',
          allergies: [] as string[],
        };
      })()
    : {
        firstName: '',
        lastName: '',
        dateOfBirth: '',
        schoolName: '',
        schoolYear: '',
        schoolGrade: '',
        contactPhone: '',
        contactEmail: '',
        medicalNotes: '',
        allergies: [] as string[],
      };

  const [formData, setFormData] = useState(initialFormData);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const dateOfBirth = new Date(formData.dateOfBirth);
    
    onSave({
      firstName: formData.firstName,
      lastName: formData.lastName,
      dateOfBirth,
      age: calculateAge(dateOfBirth),
      schoolName: formData.schoolName || undefined,
      schoolYear: formData.schoolYear || undefined,
      schoolGrade: formData.schoolGrade || undefined,
      contactPhone: formData.contactPhone || undefined,
      contactEmail: formData.contactEmail || undefined,
      medicalNotes: formData.medicalNotes || undefined,
      allergies: formData.allergies.length > 0 ? formData.allergies : undefined,
      status: 'active',
    });
  };

  // Show suggestions dropdown if multiple suggestions
  const showSuggestions = suggestedChildren.length > 1;

  return (
    <div className="bg-white p-6 rounded-lg shadow-sm border-2 border-blue-200 mb-6">
      <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
        <span className="text-2xl">👶</span>
        Add New Child
      </h2>
      <p className="text-sm text-gray-600 mb-4">
        Fill in your child's information to get started. Required fields are marked with *.
      </p>
      
      {showSuggestions && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
          <label className="block text-sm font-medium text-blue-900 mb-2">
            Or select from existing subscriptions:
          </label>
          <select
            onChange={(e) => {
              const index = parseInt(e.target.value);
              if (!isNaN(index) && suggestedChildren[index]) {
                const suggestion = suggestedChildren[index];
                const nameParts = suggestion.studentName.split(' ');
                setFormData(prev => ({
                  ...prev,
                  firstName: nameParts[0] || '',
                  lastName: nameParts.slice(1).join(' ') || '',
                  schoolName: suggestion.schoolName || '',
                  schoolYear: suggestion.schoolYear || '',
                }));
                setSelectedSuggestion(index);
              }
            }}
            className="w-full px-3 py-2 border border-blue-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select a student from your subscriptions...</option>
            {suggestedChildren.map((sub, index) => (
              <option key={index} value={index}>
                {sub.studentName} {sub.schoolName ? `(${sub.schoolName})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              First Name *
            </label>
            <input
              type="text"
              required
              value={formData.firstName}
              onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
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
              value={formData.lastName}
              onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
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
            value={formData.dateOfBirth}
            onChange={(e) => setFormData({ ...formData, dateOfBirth: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              School Name
            </label>
            <input
              type="text"
              value={formData.schoolName}
              onChange={(e) => setFormData({ ...formData, schoolName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              School Year
            </label>
            <input
              type="text"
              value={formData.schoolYear}
              onChange={(e) => setFormData({ ...formData, schoolYear: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700"
          >
            Add Child
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="bg-gray-200 text-gray-700 px-6 py-2 rounded-lg hover:bg-gray-300"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

