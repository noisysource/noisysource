import React from 'react';
import { useFormContext } from './FormContext';
import { Card, Button, Input, Label } from './common';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export const Step2 = ({ nextStep, prevStep }: { nextStep: () => void, prevStep: () => void }) => {
  const { formData: rawFormData, handleChange } = useFormContext();
  // Legacy form uses old field names not in TransportationSubscription
  const formData = rawFormData as any;
  return (
    <Card>
      <h3 className="text-xl font-semibold mb-6 text-center">Informações de Contacto e do Aluno</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <Label>Nome do Responsável</Label>
          <Input type="text" name="parentName" value={formData.parentName || ''} onChange={handleChange} required />
        </div>
        <div>
          <Label>Email de Contacto</Label>
          <Input type="email" name="contactEmail" value={formData.contactEmail || ''} onChange={handleChange} required />
        </div>
        <div>
          <Label>Telemóvel de Contacto</Label>
          <Input type="tel" name="contactMobile" value={formData.contactMobile || ''} onChange={handleChange} required />
        </div>
        <div>
          <Label>Nome do Aluno</Label>
          <Input type="text" name="studentName" value={formData.studentName || ''} onChange={handleChange} required />
        </div>
        <div>
          <Label>Idade do Aluno</Label>
          <Input type="number" name="studentAge" value={formData.studentAge || 0} onChange={handleChange} min="0" required />
        </div>
      </div>
      <div className="flex justify-between mt-8">
        <Button onClick={prevStep} variant="secondary"><ChevronLeft size={18} /> Anterior</Button>
        <Button onClick={nextStep}>Próximo <ChevronRight size={18} /></Button>
      </div>
    </Card>
  );
};
