import { useState, useEffect, lazy, Suspense } from 'react';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { db } from '../lib/firebase';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { trackClick } from '../lib/analytics';
import { FeatureFlags } from '@shared/models/FeatureFlags';
import { useUser } from '@shared/hooks';
import SocialShare from '../components/SocialShare';

const BookingPanel = lazy(() => import('../components/BookingPanel'));
const StudyRoomForm = lazy(() => import('../components/StudyRoomForm'));
const TransportationSubscriptionForm = lazy(() => import('../components/TransportationSubscriptionForm'));
const ChristmasCampSignup = lazy(() => import('../components/ChristmasCampSignup'));

type ActiveService = 'booking' | 'study' | 'transport' | 'camp' | null;

function AuthGate({ service, isLoggedIn }: { service: 'study' | 'transport'; isLoggedIn: boolean }) {
  const enrollPath = service === 'study' ? '/client/enroll/study' : '/client/enroll/transport';

  return (
    <div className="max-w-2xl mx-auto mt-6 mb-2 border border-indigo-200 bg-indigo-50 rounded-xl p-5 text-center space-y-3">
      {isLoggedIn ? (
        <>
          <p className="text-sm font-medium text-indigo-700">
            ✅ Já tem conta. Pronto para se inscrever?
          </p>
          <Link
            to={enrollPath}
            className="inline-block bg-indigo-600 text-white font-semibold px-6 py-2.5 rounded-lg hover:bg-indigo-700 transition text-sm"
          >
            Ir para inscrição →
          </Link>
        </>
      ) : (
        <>
          <p className="text-sm font-semibold text-indigo-800">
            💡 Gosta do que vê? Crie uma conta gratuita para se inscrever.
          </p>
          <p className="text-xs text-indigo-600">
            Os preços acima são a simulação real com base na sua configuração.
          </p>
          <div className="flex justify-center gap-3 flex-wrap">
            <Link
              to="/login"
              className="bg-indigo-600 text-white font-semibold px-5 py-2 rounded-lg hover:bg-indigo-700 transition text-sm"
            >
              👤 Criar conta grátis
            </Link>
            <Link
              to="/login"
              className="border border-indigo-300 text-indigo-700 font-medium px-5 py-2 rounded-lg hover:bg-indigo-100 transition text-sm"
            >
              Já tenho conta — Entrar
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

export default function LandingPage() {
  const user = useUser();
  const isLoggedIn = !!user;

  const [lang, setLang] = useState<'pt' | 'en'>('pt');
  const [activeService, setActiveService] = useState<ActiveService>(null);
  const [studyConfig, setStudyConfig] = useState<StudyCenterConfig | null>(null);
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [featureFlags, setFeatureFlags] = useState<FeatureFlags>({});

  useEffect(() => {
    const unsubscribe = onSnapshot(doc(db, 'config', 'featureFlags'), (snap) => {
      if (snap.exists()) setFeatureFlags(snap.data() as FeatureFlags);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (activeService === 'study' && !studyConfig) {
      setIsLoadingConfig(true);
      getDoc(doc(db, 'config', 'studyCenter'))
        .then(snap => { if (snap.exists()) setStudyConfig(snap.data() as StudyCenterConfig); })
        .catch(err => console.error('Error fetching study config:', err))
        .finally(() => setIsLoadingConfig(false));
    }
  }, [activeService, studyConfig]);

  const openService = (service: ActiveService, featureFlag: boolean, analyticsName: string) => {
    if (!featureFlag) return;
    trackClick('service_click', { service_name: analyticsName });
    setActiveService(prev => prev === service ? null : service);
    setTimeout(() => document.getElementById(service ?? '')?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const t = {
    pt: {
      heroTitle: 'Arco-Íris da Pequenada',
      heroSubtitle: 'Educação, Diversão e Momentos Felizes para Crianças!',
      aboutTitle: 'Sobre Nós',
      aboutText: 'Criamos experiências inesquecíveis através de festas, campos de férias e apoio escolar.',
      contactTitle: 'Contacto',
    },
    en: {
      heroTitle: 'Arco-Íris da Pequenada',
      heroSubtitle: 'Education, Fun, and Unforgettable Moments for Kids!',
      aboutTitle: 'About Us',
      aboutText: 'We create unforgettable experiences through parties, summer camps and after-school tutoring.',
      contactTitle: 'Contact',
    },
  };

  const serviceCard = (
    id: ActiveService,
    flag: boolean,
    analyticsName: string,
    colorClass: string,
    emoji: string,
    titlePt: string,
    titleEn: string,
    descPt: string,
    descEn: string,
  ) => (
    <div
      className={`p-4 border rounded-xl shadow-sm text-sm relative transition-all ${
        flag ? `${colorClass} cursor-pointer ${activeService === id ? 'ring-2 ring-indigo-400' : ''}` : 'bg-gray-200 text-gray-500'
      }`}
      onClick={() => openService(id, flag, analyticsName)}
    >
      {!flag && (
        <div className="absolute top-0 right-0 bg-yellow-400 text-yellow-800 text-xs font-bold px-2 py-1 rounded-bl-lg">
          Coming Soon
        </div>
      )}
      <h3 className="text-lg font-bold mb-1">{emoji} {lang === 'pt' ? titlePt : titleEn}</h3>
      <p>{lang === 'pt' ? descPt : descEn}</p>
      {flag && (
        <p className="mt-2 text-xs font-medium text-indigo-600">
          {activeService === id ? '▲ Fechar' : '▼ Ver preços e simular'}
        </p>
      )}
    </div>
  );

  return (
    <div className="font-fredoka bg-white text-gray-800">
      {/* Top bar */}
      <div className="flex justify-between items-center p-2 px-4">
        <button
          className="text-xs text-pink-600 underline hover:text-pink-800 transition"
          onClick={() => setLang(lang === 'pt' ? 'en' : 'pt')}
        >
          {lang === 'pt' ? 'EN' : 'PT'}
        </button>
        <Link
          to="/login"
          className="text-sm font-medium text-blue-600 hover:text-blue-800 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50 transition"
        >
          {lang === 'pt' ? 'Área de Clientes' : 'Client Area'}
        </Link>
      </div>

      {/* Hero */}
      <section className="text-center py-8 px-4 bg-gradient-to-r from-pink-100 to-blue-100">
        <img src="/logo.png" alt="Logo" className="h-16 mx-auto mb-4 object-contain" />
        <h1 className="text-3xl font-bold mb-2 text-pink-600">{t[lang].heroTitle}</h1>
        <p className="text-base text-gray-700 mb-6">{t[lang].heroSubtitle}</p>
        <Link
          to="/login"
          className="inline-block bg-blue-600 text-white font-semibold px-6 py-3 rounded-xl hover:bg-blue-700 transition shadow-sm"
        >
          {lang === 'pt' ? '👤 Área de Clientes — Entrar / Registar' : '👤 Client Area — Sign in / Register'}
        </Link>
      </section>

      {/* Service cards */}
      <section id="services" className="py-8 px-4 text-center">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 max-w-6xl mx-auto">
          {serviceCard('booking', featureFlags.party ?? false, 'Parties', 'bg-pink-50', '🎈',
            'Festas', 'Parties', 'Festas únicas com muita animação.', 'Unique and fun birthday parties.')}
          {serviceCard('camp', featureFlags.summerCamps ?? false, 'Christmas Camp', 'bg-yellow-50', '🎄',
            'Actividades de natal 2025', 'Christmas Camp',
            'Magia e diversão garantida!', 'Christmas Camp 2025 - 9 days of fun!')}
          {serviceCard('study', featureFlags.studyRoom ?? false, 'Study Room', 'bg-blue-50', '📚',
            'Sala de Estudo', 'Study Room',
            'Apoio escolar com método e carinho.', 'Tutoring with care and structure.')}
          {serviceCard('transport', featureFlags.transportation ?? false, 'Transportation', 'bg-purple-50', '🚌',
            'Transporte', 'Transportation',
            'Serviço de transporte.', 'Transportation service to and from school.')}
        </div>
      </section>

      {/* Booking */}
      <section id="booking">
        <Suspense fallback={<div className="text-center p-4">A carregar...</div>}>
          {activeService === 'booking' && <BookingPanel />}
        </Suspense>
      </section>

      {/* Camp */}
      <section id="camp">
        <Suspense fallback={<div className="text-center p-4">A carregar...</div>}>
          {activeService === 'camp' && <ChristmasCampSignup />}
        </Suspense>
      </section>

      {/* Study room — simulation mode */}
      <section id="study">
        <Suspense fallback={<div className="text-center p-4">A carregar...</div>}>
          {activeService === 'study' && (
            <>
              {isLoadingConfig && <p className="text-center p-4">A carregar...</p>}
              {!isLoadingConfig && !studyConfig && <p className="text-center p-4 text-red-500">Não foi possível carregar o formulário.</p>}
              {!isLoadingConfig && studyConfig && (
                <>
                  <StudyRoomForm priceConfig={studyConfig} isSimulation />
                  <AuthGate service="study" isLoggedIn={isLoggedIn} />
                </>
              )}
            </>
          )}
        </Suspense>
      </section>

      {/* Transportation — simulation mode */}
      <section id="transport">
        <Suspense fallback={<div className="text-center p-4">A carregar...</div>}>
          {activeService === 'transport' && (
            <>
              <TransportationSubscriptionForm isSimulation />
              <AuthGate service="transport" isLoggedIn={isLoggedIn} />
            </>
          )}
        </Suspense>
      </section>

      {/* About */}
      <section className="py-6 px-4 text-center bg-gray-50 text-sm">
        <h2 className="text-xl font-semibold mb-2 text-blue-600">{t[lang].aboutTitle}</h2>
        <p className="max-w-xl mx-auto text-gray-700">{t[lang].aboutText}</p>
      </section>

      {/* Contact */}
      <section className="py-6 px-4 text-center text-sm">
        <h2 className="text-xl font-semibold mb-2 text-blue-600">{t[lang].contactTitle}</h2>
        <p className="mb-1">
          Email:{' '}
          <a href="mailto:geral.arcoirisdapequenada@gmail.com" className="text-pink-600 underline hover:text-pink-800">
            geral.arcoirisdapequenada@gmail.com
          </a>
        </p>
        <p className="text-gray-700">Coimbra – Avenida da Guarda Inglesa, Lote E</p>
      </section>

      {/* Legal compliance */}
      <section className="py-6 px-4 bg-blue-50 border-t border-blue-100 text-sm text-center">
        <div className="max-w-2xl mx-auto space-y-4">
          <div>
            <a
              href="https://www.livroreclamacoes.pt/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 font-semibold text-red-600 underline hover:text-red-800"
            >
              📋 {lang === 'pt' ? 'Livro de Reclamações' : 'Complaints Book'}
            </a>
            <p className="text-gray-600 mt-1 text-xs">
              {lang === 'pt'
                ? 'Nos termos do artigo 5.º-B do Decreto-Lei n.º 74/2017, disponibilizamos acesso ao Livro de Reclamações Eletrónico.'
                : 'In accordance with Decree-Law No. 74/2017, we provide access to the Electronic Complaints Book.'}
            </p>
          </div>
          <div>
            <a
              href="https://www.consumidor.gov.pt/parceiros/sistema-de-defesa-do-consumidor/entidades-de-resolucao-alternativa-de-litigios-ral.aspx"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 font-semibold text-blue-600 underline hover:text-blue-800"
            >
              ⚖️ {lang === 'pt' ? 'Resolução Alternativa de Litígios (RAL)' : 'Alternative Dispute Resolution (ADR)'}
            </a>
            <p className="text-gray-600 mt-1 text-xs">
              {lang === 'pt'
                ? 'Em caso de litígio, o consumidor pode recorrer a uma entidade de Resolução Alternativa de Litígios.'
                : 'In case of dispute, consumers may contact an Alternative Dispute Resolution entity.'}
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center text-xs text-gray-500 py-6 bg-gray-100">
        <div className="flex flex-col items-center space-y-4">
          <SocialShare url="https://your-website-url.com" title={t[lang].heroTitle} />
          <p>© {new Date().getFullYear()} Arco-Íris da Pequenada</p>
        </div>
      </footer>
    </div>
  );
}
