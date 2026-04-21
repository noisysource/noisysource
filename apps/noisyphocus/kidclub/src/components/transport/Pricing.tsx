import React, { useState, useEffect } from 'react';
import { useFormContext } from './FormContext';

export const Pricing = () => {
  const { subtotal, discount, transportationConfig } = useFormContext();
  const vatRate = transportationConfig?.vatRate || 0.23;
  
  const subtotalAfterDiscount = subtotal - discount;
  const vat = subtotalAfterDiscount * vatRate;
  const total = subtotalAfterDiscount + vat;

  const [highlight, setHighlight] = useState(false);

  useEffect(() => {
    if (subtotal > 0) {
      setHighlight(true);
      const timer = setTimeout(() => setHighlight(false), 500); // Highlight for 500ms
      return () => clearTimeout(timer);
    }
  }, [subtotal, discount]);

  return (
    <div className="bg-gray-50 p-6 rounded-lg shadow-sm sticky top-6">
      <h3 className="text-xl font-semibold mb-4 border-b pb-3">Preçário Estimado</h3>
      <div className="space-y-2 text-gray-700">
        <div className="flex justify-between"><span>Subtotal:</span><span className="font-medium">€{subtotal.toFixed(2)}</span></div>
        {discount > 0 && (
          <div className="flex justify-between text-green-600"><span>Desconto:</span><span className="font-medium">- €{discount.toFixed(2)}</span></div>
        )}
        <div className="flex justify-between"><span>IVA ({vatRate * 100}%):</span><span className="font-medium">€{vat.toFixed(2)}</span></div>
        <div className={`flex justify-between font-bold text-lg text-gray-900 border-t pt-3 mt-3 transition-all duration-500 ${highlight ? 'bg-yellow-100' : ''}`}>
            <span>Total:</span>
            <span>€{total.toFixed(2)}</span>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-4">Este é um preço estimado. O valor final será confirmado pela nossa equipa.</p>
    </div>
  );
};
