import React from 'react';
import { Card, Button } from './common';
import { ChevronLeft } from 'lucide-react';

export const Step4 = ({ prevStep, loading, handleSubmit }: { prevStep: () => void, loading: boolean, handleSubmit: (e: React.FormEvent) => void }) => (
  <Card className="text-center">
    <h3 className="text-2xl font-bold text-gray-800 mb-4">Confirmação</h3>
    <p className="text-gray-600 mb-6">Por favor, reveja todos os detalhes antes de submeter o seu pedido. Após a submissão, a nossa equipa entrará em contacto para confirmar.</p>
    <div className="flex justify-center gap-4 mt-8">
      <Button onClick={prevStep} variant="secondary"><ChevronLeft size={18} /> Anterior</Button>
      <Button onClick={handleSubmit} disabled={loading}>{loading ? 'A Enviar...' : 'Confirmar e Enviar Pedido'}</Button>
    </div>
  </Card>
);
