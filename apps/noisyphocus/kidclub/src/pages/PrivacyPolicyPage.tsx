export default function PrivacyPolicyPage() {
  return (
    <div className="font-fredoka bg-white min-h-screen">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <a href="/" className="text-sm text-blue-600 hover:underline mb-8 inline-block">← Voltar</a>

        <h1 className="text-3xl font-bold text-gray-900 mb-2">Política de Privacidade</h1>
        <p className="text-sm text-gray-400 mb-10">Última atualização: novembro de 2026</p>

        <div className="prose prose-gray max-w-none space-y-8 text-sm text-gray-700 leading-relaxed">

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">1. Responsável pelo tratamento</h2>
            <p>
              A entidade responsável pelo tratamento dos seus dados pessoais é a <strong>Noisy Phocus, Lda.</strong>,
              que opera sob a marca <strong>Arco-Íris da Pequenada</strong>, com sede na Avenida da Guarda Inglesa,
              Lote E, Coimbra, NIF 518942120, contacto:{' '}
              <a href="mailto:geral.arcoirisdapequenada@gmail.com" className="text-blue-600 underline">
                geral.arcoirisdapequenada@gmail.com
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">2. Dados recolhidos</h2>
            <p>Recolhemos os seguintes dados pessoais:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Dados de identificação: nome, email, número de telemóvel</li>
              <li>Dados de faturação: NIF, morada de faturação</li>
              <li>Dados das crianças: nome, data de nascimento, escola, ano escolar</li>
              <li>Dados de utilização dos serviços: subscrições ativas, histórico de pagamentos</li>
              <li>Dados de pagamento: processados exclusivamente pela Easypay — não armazenamos dados de cartão</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">3. Finalidade e base legal</h2>
            <ul className="list-disc pl-5 mt-2 space-y-2">
              <li>
                <strong>Execução do contrato</strong> (art. 6.º, n.º 1, al. b) RGPD): prestação dos serviços
                contratados (sala de estudo, transporte escolar, festas, campos de férias), emissão de faturas
                e gestão de pagamentos.
              </li>
              <li>
                <strong>Obrigação legal</strong> (art. 6.º, n.º 1, al. c) RGPD): cumprimento de obrigações
                fiscais e contabilísticas.
              </li>
              <li>
                <strong>Interesse legítimo</strong> (art. 6.º, n.º 1, al. f) RGPD): comunicações sobre o estado
                das inscrições e pagamentos.
                <br />
                O portal regista também os passos do formulário de inscrição, sem cookies, durante 90 dias, para
                detetar problemas e melhorar o formulário.
              </li>
              <li>
                <strong>Consentimento</strong> (art. 6.º, n.º 1, al. a) RGPD): envio de comunicações de marketing,
                quando aplicável.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">4. Conservação dos dados</h2>
            <p>
              Os dados são conservados pelo prazo necessário à execução do contrato e, após o seu término,
              pelo período mínimo exigido por lei (nomeadamente 10 anos para efeitos fiscais). Dados de crianças
              são eliminados mediante pedido dos encarregados de educação, salvo obrigação legal em contrário.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">5. Destinatários dos dados</h2>
            <p>Os seus dados podem ser partilhados com:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li><strong>Easypay</strong> — processamento de pagamentos (Portugal)</li>
              <li><strong>Google Firebase / Google Cloud</strong> — alojamento da plataforma e base de dados</li>
              <li><strong>Vendus</strong> — emissão de faturas certificadas (Portugal)</li>
              <li>Autoridades fiscais e regulatórias, quando legalmente obrigados</li>
            </ul>
            <p className="mt-2">
              Todos os subcontratantes estão sujeitos a acordos de tratamento de dados e cumprem o RGPD.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">6. Direitos dos titulares</h2>
            <p>Nos termos do RGPD, tem direito a:</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Aceder aos seus dados pessoais</li>
              <li>Retificar dados incorretos ou incompletos</li>
              <li>Solicitar o apagamento dos dados ("direito a ser esquecido")</li>
              <li>Opor-se ao tratamento ou solicitar a sua limitação</li>
              <li>Portabilidade dos dados</li>
              <li>Retirar o consentimento a qualquer momento</li>
              <li>Apresentar reclamação à <strong>CNPD</strong> (www.cnpd.pt)</li>
            </ul>
            <p className="mt-2">
              Para exercer os seus direitos, contacte-nos em{' '}
              <a href="mailto:geral.arcoirisdapequenada@gmail.com" className="text-blue-600 underline">
                geral.arcoirisdapequenada@gmail.com
              </a>.
              Respondemos no prazo de 30 dias.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">7. Segurança</h2>
            <p>
              Adotamos medidas técnicas e organizacionais adequadas para proteger os seus dados contra acesso
              não autorizado, perda ou destruição, incluindo encriptação em trânsito (HTTPS), controlo de
              acessos e autenticação segura.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">8. Proteção de dados de menores</h2>
            <p>
              Os dados de crianças são recolhidos exclusivamente com base no consentimento e autorização dos
              encarregados de educação. Não recolhemos dados de menores sem o conhecimento e aprovação explícita
              do responsável legal.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">9. Alterações a esta política</h2>
            <p>
              Podemos atualizar esta Política de Privacidade. Alterações materiais serão comunicadas por email
              ou mediante aviso destacado na plataforma. A utilização continuada dos serviços após a comunicação
              implica a aceitação das alterações.
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}
