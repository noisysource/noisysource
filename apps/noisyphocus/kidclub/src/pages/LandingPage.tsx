import { useState, useEffect, lazy, Suspense } from 'react';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { StudyCenterConfig } from '@shared/models/StudyCenterConfig';
import { trackClick } from '../lib/analytics';
import { FeatureFlags } from '@shared/models/FeatureFlags';
import SocialShare from '../components/SocialShare';

const BookingPanel = lazy(() => import('../components/BookingPanel'));
const StudyRoomForm = lazy(() => import('../components/StudyRoomForm'));
const TransportationSubscriptionForm = lazy(() => import('../components/TransportationSubscriptionForm'));
const ChristmasCampSignup = lazy(() => import('../components/ChristmasCampSignup'));

export default function LandingPage() {
  const [lang, setLang] = useState<'pt' | 'en'>('pt');
  const [showBooking, setShowBooking] = useState(false);
  const [showStudy, setShowStudy] = useState(false);
  const [showTransportation, setShowTransportation] = useState(false);
  const [showCamp, setShowCamp] = useState(false);
  const [studyConfig, setStudyConfig] = useState<StudyCenterConfig | null>(null);
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [featureFlags, setFeatureFlags] = useState<FeatureFlags>({});

  useEffect(() => {
    const featureFlagsDocRef = doc(db, 'config', 'featureFlags');
    const unsubscribe = onSnapshot(featureFlagsDocRef, (docSnap) => {
      if (docSnap.exists()) {
        setFeatureFlags(docSnap.data() as FeatureFlags);
      }
    });

    if (showStudy && !studyConfig) {
      setIsLoadingConfig(true);
      const fetchConfig = async () => {
        try {
          const configDocRef = doc(db, 'config', 'studyCenter');
          const docSnap = await getDoc(configDocRef);
          if (docSnap.exists()) {
            setStudyConfig(docSnap.data() as StudyCenterConfig);
          }
        } catch (error) {
          console.error("Error fetching study center config:", error);
        } finally {
          setIsLoadingConfig(false);
        }
      };
      fetchConfig();
    }

    return () => unsubscribe();
  }, [showStudy, studyConfig]);

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

  return (
    <div className="font-fredoka bg-white text-gray-800">
      {/* Language toggle */}
      <div className="flex justify-end p-2 pr-4">
        <button
          className="text-xs text-pink-600 underline hover:text-pink-800 transition"
          onClick={() => setLang(lang === 'pt' ? 'en' : 'pt')}
        >
          {lang === 'pt' ? 'EN' : 'PT'}
        </button>
      </div>

      {/* Hero */}
      <section className="text-center py-8 px-4 bg-gradient-to-r from-pink-100 to-blue-100">
        <img src="/logo.png" alt="Logo" className="h-16 mx-auto mb-4 object-contain" />
        <h1 className="text-3xl font-bold mb-2 text-pink-600">{t[lang].heroTitle}</h1>
        <p className="text-base text-gray-700 mb-4">{t[lang].heroSubtitle}</p>
      </section>

      {/* Services */}
      <section id="services" className="py-8 px-4 text-center">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 max-w-6xl mx-auto">
          <div
            className={`p-4 border rounded-xl shadow-sm text-sm relative ${featureFlags.party
              ? 'bg-pink-50 cursor-pointer'
              : 'bg-gray-200 text-gray-500'
              }`}
            onClick={() => {
              if (featureFlags.party) {
                trackClick('service_click', { service_name: 'Parties' });
                setShowStudy(false)
                setShowBooking(true);
                setShowTransportation(false);
                document.getElementById('booking')?.scrollIntoView({ behavior: 'smooth' });
              }
            }}>
            {!featureFlags.party && (
              <div className="absolute top-0 right-0 bg-yellow-400 text-yellow-800 text-xs font-bold px-2 py-1 rounded-bl-lg">
                Coming Soon
              </div>
            )}
            <h3 className="text-lg font-bold mb-1">🎈 {lang === 'pt' ? 'Festas' : 'Parties'}</h3>
            <p>{lang === 'pt' ? 'Festas únicas com muita animação.' : 'Unique and fun birthday parties.'}</p>
          </div>
          <div
            className={`p-4 border rounded-xl shadow-sm text-sm relative ${featureFlags.summerCamps
              ? 'bg-yellow-50 cursor-pointer'
              : 'bg-gray-200 text-gray-500'
              }`}
            onClick={() => {
              if (featureFlags.summerCamps) {
                trackClick('service_click', { service_name: 'Christmas Camp' });
                setShowBooking(false);
                setShowStudy(false);
                setShowTransportation(false);
                setShowCamp(true);
                document.getElementById('camp')?.scrollIntoView({ behavior: 'smooth' });
              }
            }}
          >
            {!featureFlags.summerCamps && (
              <div className="absolute top-0 right-0 bg-yellow-400 text-yellow-800 text-xs font-bold px-2 py-1 rounded-bl-lg">
                Coming Soon
              </div>
            )}
            <h3 className="text-lg font-bold mb-1">🎄 {lang === 'pt' ? 'Actividades de natal 2025' : 'Christmas Camp'}</h3>
            <p>{lang === 'pt' ? 'Magia e diversão garantida!' : 'Christmas Camp 2025 - 9 days of fun!'}</p>
          </div>
          <div
            className={`p-4 border rounded-xl shadow-sm text-sm relative ${featureFlags.studyRoom
              ? 'bg-blue-50 cursor-pointer'
              : 'bg-gray-200 text-gray-500'
              }`}
            onClick={() => {
              if (featureFlags.studyRoom) {
                trackClick('service_click', { service_name: 'Study Room' });
                setShowBooking(false);
                setShowStudy(true)
                setShowTransportation(false);
                document.getElementById('study')?.scrollIntoView({ behavior: 'smooth' });
              }
            }}>
            {!featureFlags.studyRoom && (
              <div className="absolute top-0 right-0 bg-yellow-400 text-yellow-800 text-xs font-bold px-2 py-1 rounded-bl-lg">
                Coming Soon
              </div>
            )}
            <h3 className="text-lg font-bold mb-1">📚 Sala de Estudo</h3>
            <p>{lang === 'pt' ? 'Apoio escolar com método e carinho.' : 'Tutoring with care and structure.'}</p>
          </div>
          <div
            className={`p-4 border rounded-xl shadow-sm text-sm relative ${featureFlags.transportation
              ? 'bg-purple-50 cursor-pointer'
              : 'bg-gray-200 text-gray-500'
              }`}
            onClick={() => {
              if (featureFlags.transportation) {
                trackClick('service_click', { service_name: 'Transportation' });
                setShowBooking(false);
                setShowStudy(false);
                setShowTransportation(true);
                document.getElementById('transportation')?.scrollIntoView({ behavior: 'smooth' });
              }
            }}
          >
            {!featureFlags.transportation && (
              <div className="absolute top-0 right-0 bg-yellow-400 text-yellow-800 text-xs font-bold px-2 py-1 rounded-bl-lg">
                Coming Soon
              </div>
            )}
            <h3 className="text-lg font-bold mb-1">🚌 {lang === 'pt' ? 'Transporte' : 'Transportation'}</h3>
            <p>{lang === 'pt' ? 'Serviço de transporte.' : 'Transportation service to and from school.'}</p>
          </div>
        </div>
      </section>

      <section id="booking">
        <Suspense fallback={<div className="text-center p-4">A carregar...</div>}>
          {showBooking && <BookingPanel />}
        </Suspense>
      </section>

      <section id="study">
        <Suspense fallback={<div className="text-center p-4">A carregar...</div>}>
          {showStudy && (
            isLoadingConfig ? <p>A carregar...</p> : (studyConfig ? <StudyRoomForm priceConfig={studyConfig} /> : <p>Não foi possível carregar o formulário.</p>)
          )}
        </Suspense>
      </section>

      <section id="transportation">
        <Suspense fallback={<div className="text-center p-4">A carregar...</div>}>
          {showTransportation && <TransportationSubscriptionForm />}
        </Suspense>
      </section>

      <section id="camp">
        <Suspense fallback={<div className="text-center p-4">A carregar...</div>}>
          {showCamp && <ChristmasCampSignup />}
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