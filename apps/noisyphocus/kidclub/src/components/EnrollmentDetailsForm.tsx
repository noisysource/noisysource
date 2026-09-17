import PlacesInput from './PlacesInput';

export interface EnrollmentAddressValue {
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

export const EMPTY_ENROLLMENT_ADDRESS: EnrollmentAddressValue = {
  street: '', city: '', postalCode: '', country: 'Portugal',
};

// Single schema for "who is this child, how do we reach the family" — used by both the
// admin "Nova inscrição" flow and the parent-facing enrollment pages. contactEmail only,
// never email (see StudyRoomEntry docs for why that distinction matters historically).
export interface EnrollmentDetailsValue {
  firstName: string;
  lastName: string;
  dateOfBirth: string; // YYYY-MM-DD
  schoolName: string;
  schoolYear: string;
  homeAddress: EnrollmentAddressValue;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

export const EMPTY_ENROLLMENT_DETAILS: EnrollmentDetailsValue = {
  firstName: '', lastName: '', dateOfBirth: '', schoolName: '', schoolYear: '',
  homeAddress: EMPTY_ENROLLMENT_ADDRESS,
  contactName: '', contactEmail: '', contactPhone: '',
};

// firstName/lastName/dateOfBirth were already required; schoolName, schoolYear, and a
// complete homeAddress (street/city/postalCode — country has a default) are required too.
export function validateEnrollmentDetails(value: EnrollmentDetailsValue): Partial<Record<keyof EnrollmentDetailsValue, string>> {
  const errors: Partial<Record<keyof EnrollmentDetailsValue, string>> = {};
  if (!value.firstName.trim()) errors.firstName = 'Obrigatório';
  if (!value.lastName.trim()) errors.lastName = 'Obrigatório';
  if (!value.dateOfBirth) errors.dateOfBirth = 'Obrigatório';
  if (!value.schoolName.trim()) errors.schoolName = 'Obrigatório';
  if (!value.schoolYear.trim()) errors.schoolYear = 'Obrigatório';
  if (!value.homeAddress.street.trim() || !value.homeAddress.city.trim() || !value.homeAddress.postalCode.trim()) {
    errors.homeAddress = 'Rua, cidade e código postal são obrigatórios';
  }
  return errors;
}

interface Props {
  value: EnrollmentDetailsValue;
  onChange: (value: EnrollmentDetailsValue) => void;
  // Parent flow: contact info is implicit from the logged-in account, so those fields
  // are redundant there — admin flow needs them since there's no logged-in parent yet.
  showContactFields?: boolean;
  errors?: Partial<Record<keyof EnrollmentDetailsValue, string>>;
}

export default function EnrollmentDetailsForm({ value, onChange, showContactFields = true, errors = {} }: Props) {
  const set = <K extends keyof EnrollmentDetailsValue>(field: K, v: EnrollmentDetailsValue[K]) =>
    onChange({ ...value, [field]: v });
  const setAddress = <K extends keyof EnrollmentAddressValue>(field: K, v: EnrollmentAddressValue[K]) =>
    onChange({ ...value, homeAddress: { ...value.homeAddress, [field]: v } });

  const fieldCls = (field: keyof EnrollmentDetailsValue) =>
    `w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 ${errors[field] ? 'border-red-400' : 'border-gray-300'}`;
  const addrCls = 'w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 border-gray-300';

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Primeiro nome *</label>
          <input type="text" value={value.firstName} onChange={e => set('firstName', e.target.value)}
            className={fieldCls('firstName')} />
          {errors.firstName && <p className="text-xs text-red-500 mt-1">{errors.firstName}</p>}
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Apelido *</label>
          <input type="text" value={value.lastName} onChange={e => set('lastName', e.target.value)}
            className={fieldCls('lastName')} />
          {errors.lastName && <p className="text-xs text-red-500 mt-1">{errors.lastName}</p>}
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">Data de nascimento *</label>
        <input type="date" value={value.dateOfBirth} onChange={e => set('dateOfBirth', e.target.value)}
          max={new Date().toISOString().split('T')[0]} className={fieldCls('dateOfBirth')} />
        {errors.dateOfBirth && <p className="text-xs text-red-500 mt-1">{errors.dateOfBirth}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Escola *</label>
          <PlacesInput value={value.schoolName} onChange={v => set('schoolName', v)}
            types={['school', 'primary_school', 'secondary_school']} nameOnly className={fieldCls('schoolName')} />
          {errors.schoolName && <p className="text-xs text-red-500 mt-1">{errors.schoolName}</p>}
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Ano letivo *</label>
          <input type="text" placeholder="ex: 2024/2025" value={value.schoolYear}
            onChange={e => set('schoolYear', e.target.value)} className={fieldCls('schoolYear')} />
          {errors.schoolYear && <p className="text-xs text-red-500 mt-1">{errors.schoolYear}</p>}
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">Morada *</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input type="text" placeholder="Rua e número" value={value.homeAddress.street}
            onChange={e => setAddress('street', e.target.value)} className={`${addrCls} sm:col-span-2`} />
          <input type="text" placeholder="Cidade" value={value.homeAddress.city}
            onChange={e => setAddress('city', e.target.value)} className={addrCls} />
          <input type="text" placeholder="Código postal" value={value.homeAddress.postalCode}
            onChange={e => setAddress('postalCode', e.target.value)} className={addrCls} />
          <input type="text" placeholder="País" value={value.homeAddress.country}
            onChange={e => setAddress('country', e.target.value)} className={`${addrCls} sm:col-span-2`} />
        </div>
        {errors.homeAddress && <p className="text-xs text-red-500 mt-1">{errors.homeAddress}</p>}
      </div>

      {showContactFields && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Nome do encarregado</label>
            <input type="text" value={value.contactName} onChange={e => set('contactName', e.target.value)}
              className={fieldCls('contactName')} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Email do encarregado *</label>
            <input type="email" value={value.contactEmail} onChange={e => set('contactEmail', e.target.value)}
              className={fieldCls('contactEmail')} />
            {errors.contactEmail && <p className="text-xs text-red-500 mt-1">{errors.contactEmail}</p>}
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs text-gray-500 mb-1">Telefone</label>
            <input type="tel" value={value.contactPhone} onChange={e => set('contactPhone', e.target.value)}
              className={fieldCls('contactPhone')} />
          </div>
        </div>
      )}
    </div>
  );
}
