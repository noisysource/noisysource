import React from 'react';

export const Stepper = ({ currentStep }: { currentStep: number }) => {
  const steps = ["Tipo", "Contacto", "Detalhes", "Confirmar"];
  return (
    <div className="flex items-center justify-center mb-10">
      {steps.map((label, index) => {
        const stepNumber = index + 1;
        const isActive = stepNumber <= currentStep;
        return (
          <React.Fragment key={stepNumber}>
            <div className="flex flex-col items-center">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-lg ${isActive ? 'bg-purple-600' : 'bg-gray-300'}`}>
                {stepNumber}
              </div>
              <p className={`mt-2 text-sm font-semibold ${isActive ? 'text-purple-600' : 'text-gray-400'}`}>{label}</p>
            </div>
            {index < steps.length - 1 && (
              <div className={`flex-auto border-t-4 mx-2 transition-colors ${isActive && currentStep > stepNumber ? 'border-purple-600' : 'border-gray-300'}`}></div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};
