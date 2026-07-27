import { useState } from 'react';
import { Link } from 'react-router-dom';
import SocialShare from '../components/SocialShare';

export default function LandingPage() {
  const [lang, setLang] = useState<'pt' | 'en'>('pt');

  const pt = lang === 'pt';

  const services = [
    {
      emoji: '🎈',
      title: pt ? 'Festas' : 'Parties',
      desc: pt
        ? 'Festas de aniversário únicas com muita animação, jogos e diversão para todas as idades.'
        : 'Unique birthday parties with entertainment, games and fun for all ages.',
      color: 'bg-pink-50 border-pink-200',
      badge: 'text-pink-600',
    },
    {
      emoji: '🎄',
      title: pt ? 'Campos de Férias' : 'Holiday Camps',
      desc: pt
        ? 'Campos de férias de Natal e Verão com atividades criativas, desporto e muita magia.'
        : 'Christmas and Summer holiday camps with creative activities, sports and plenty of magic.',
      color: 'bg-yellow-50 border-yellow-200',
      badge: 'text-yellow-700',
    },
    {
      emoji: '📚',
      title: pt ? 'Sala de Estudo' : 'Study Room',
      desc: pt
        ? 'Apoio escolar personalizado com método, carinho e acompanhamento próximo de cada criança.'
        : 'Personalised after-school tutoring with structure, care and close follow-up for each child.',
      color: 'bg-blue-50 border-blue-200',
      badge: 'text-blue-600',
    },
    {
      emoji: '🚌',
      title: pt ? 'Transporte Escolar' : 'School Transport',
      desc: pt
        ? 'Serviço de transporte seguro e pontual de e para a escola, com rotas flexíveis.'
        : 'Safe and punctual transport to and from school, with flexible routes.',
      color: 'bg-purple-50 border-purple-200',
      badge: 'text-purple-600',
    },
  ];

  return (
    <div className="font-fredoka bg-white text-gray-800">
      {/* Top bar */}
      <div className="flex justify-between items-center p-2 px-4">
        <button
          className="text-xs text-pink-600 underline hover:text-pink-800 transition"
          onClick={() => setLang(pt ? 'en' : 'pt')}
        >
          {pt ? 'EN' : 'PT'}
        </button>
        <Link
          to="/login"
          className="text-sm font-medium text-blue-600 hover:text-blue-800 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50 transition"
        >
          {pt ? 'Área de Clientes' : 'Client Area'}
        </Link>
      </div>

      {/* Hero */}
      <section className="text-center py-12 px-4 bg-gradient-to-r from-pink-100 to-blue-100">
        <img src="/logo.png" alt="Logo" className="h-20 mx-auto mb-4 object-contain" />
        <h1 className="text-4xl font-bold mb-3 text-pink-600">Arco-Íris da Pequenada</h1>
        <p className="text-lg text-gray-700 mb-8 max-w-xl mx-auto">
          {pt
            ? 'Educação, diversão e momentos felizes para crianças em Coimbra.'
            : 'Education, fun and happy moments for children in Coimbra.'}
        </p>
        <Link
          to="/login"
          className="inline-block bg-blue-600 text-white font-semibold px-8 py-3 rounded-xl hover:bg-blue-700 transition shadow-sm text-lg"
        >
          {pt ? '👤 Entrar / Criar conta' : '👤 Sign in / Register'}
        </Link>
      </section>

      {/* Services */}
      <section className="py-12 px-4">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-center text-gray-700 mb-8">
            {pt ? 'Os nossos serviços' : 'Our services'}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {services.map((s) => (
              <div key={s.title} className={`p-6 border rounded-2xl shadow-sm ${s.color}`}>
                <p className="text-3xl mb-3">{s.emoji}</p>
                <h3 className={`text-xl font-bold mb-2 ${s.badge}`}>{s.title}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA banner */}
      <section className="py-10 px-4 bg-indigo-50 text-center">
        <h2 className="text-xl font-semibold text-indigo-800 mb-2">
          {pt ? 'Pronto para começar?' : 'Ready to get started?'}
        </h2>
        <p className="text-sm text-indigo-600 mb-5">
          {pt
            ? 'Crie a sua conta gratuitamente e inscreva os seus filhos nos nossos serviços.'
            : 'Create your free account and enrol your children in our services.'}
        </p>
        <Link
          to="/login"
          className="inline-block bg-indigo-600 text-white font-semibold px-7 py-3 rounded-xl hover:bg-indigo-700 transition shadow-sm"
        >
          {pt ? 'Criar conta grátis' : 'Create free account'}
        </Link>
      </section>

      {/* About */}
      <section className="py-10 px-4 text-center bg-gray-50 text-sm">
        <h2 className="text-xl font-semibold mb-2 text-blue-600">
          {pt ? 'Sobre nós' : 'About us'}
        </h2>
        <p className="max-w-xl mx-auto text-gray-700 leading-relaxed">
          {pt
            ? 'Somos um espaço dedicado ao bem-estar e ao desenvolvimento das crianças. Criamos experiências inesquecíveis através de festas, campos de férias e apoio escolar, sempre com carinho e profissionalismo.'
            : 'We are a space dedicated to the well-being and development of children. We create unforgettable experiences through parties, holiday camps and after-school support, always with care and professionalism.'}
        </p>
      </section>

      {/* Contact */}
      <section className="py-8 px-4 text-center text-sm">
        <h2 className="text-xl font-semibold mb-3 text-blue-600">
          {pt ? 'Contacto' : 'Contact'}
        </h2>
        <p className="mb-1">
          Email:{' '}
          <a href="mailto:geral.arcoirisdapequenada@gmail.com" className="text-pink-600 underline hover:text-pink-800">
            geral.arcoirisdapequenada@gmail.com
          </a>
        </p>
        <p className="text-gray-700">Coimbra – Avenida da Guarda Inglesa, Lote E</p>
      </section>

      {/* Legal */}
      <section className="py-6 px-4 bg-blue-50 border-t border-blue-100 text-sm text-center">
        <div className="max-w-2xl mx-auto space-y-4">
          <div>
            <a
              href="https://www.livroreclamacoes.pt/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 font-semibold text-red-600 underline hover:text-red-800"
            >
              📋 {pt ? 'Livro de Reclamações' : 'Complaints Book'}
            </a>
            <p className="text-gray-600 mt-1 text-xs">
              {pt
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
              ⚖️ {pt ? 'Resolução Alternativa de Litígios (RAL)' : 'Alternative Dispute Resolution (ADR)'}
            </a>
            <p className="text-gray-600 mt-1 text-xs">
              {pt
                ? 'Em caso de litígio, o consumidor pode recorrer a uma entidade de Resolução Alternativa de Litígios.'
                : 'In case of dispute, consumers may contact an Alternative Dispute Resolution entity.'}
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center text-xs text-gray-500 py-6 bg-gray-100">
        <div className="flex flex-col items-center space-y-4">
          <SocialShare url="https://your-website-url.com" title="Arco-Íris da Pequenada" />
          <p>© {new Date().getFullYear()} Arco-Íris da Pequenada</p>
        </div>
      </footer>
    </div>
  );
}
