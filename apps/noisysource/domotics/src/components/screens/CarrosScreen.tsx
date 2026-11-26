import { Car } from 'lucide-react';

/** Placeholder until the Tesla integration lands (STATUS.md, "Next"). */
export default function CarrosScreen() {
  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 pt-4 pb-6 flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-zinc-50" style={{ paddingTop: 'env(safe-area-inset-top)' }}>Carros</h1>
      <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 flex flex-col items-start gap-3">
        <Car size={28} className="text-sky-300" />
        <p className="text-[15px] text-zinc-200">Em breve: bateria e autonomia, localização, comandos, carregar com o sol e o custo de cada carro.</p>
        <p className="text-sm text-zinc-400">Carrega pela Schuko do Mobile Connector: 6 a 13 A, cerca de 3 kW no máximo.</p>
      </div>
    </div>
  );
}
