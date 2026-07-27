import React from 'react';
import { Link } from 'react-router-dom';
import { Card, Button } from './common';
import { ChevronLeft } from 'lucide-react';

interface Step4Props {
  prevStep: () => void;
  loading: boolean;
  handleSubmit: () => void;
  isSimulation?: boolean;
  isLoggedIn?: boolean;
}

export const Step4 = ({ prevStep, loading, handleSubmit, isSimulation, isLoggedIn }: Step4Props) => (
  <Card className="text-center">
    <h3 className="text-2xl font-bold text-gray-800 mb-4">Confirmação</h3>
    <p className="text-gray-600 mb-6">Por favor, reveja todos os detalhes antes de submeter o seu pedido. Após a submissão, a nossa equipa entrará em contacto para confirmar.</p>
    <div className="flex justify-center gap-4 mt-8">
      <Button onClick={prevStep} variant="secondary"><ChevronLeft size={18} /> Anterior</Button>
      {isSimulation ? (
        isLoggedIn
          ? <Link to="/client/subscriptions" className="bg-indigo-600 text-white px-5 py-2 rounded-lg font-semibold hover:bg-indigo-700 transition">Ir para inscrição →</Link>
          : <Link to="/login" className="bg-indigo-600 text-white px-5 py-2 rounded-lg font-semibold hover:bg-indigo-700 transition">Criar conta para continuar →</Link>
      ) : (
        <Button onClick={handleSubmit} disabled={loading}>{loading ? 'A Enviar...' : 'Confirmar e Enviar Pedido'}</Button>
      )}
    </div>
  </Card>
);
