export default function TermsPage() {
  return (
    <div className="font-fredoka bg-white min-h-screen">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <a href="/" className="text-sm text-blue-600 hover:underline mb-8 inline-block">← Voltar</a>

        <h1 className="text-3xl font-bold text-gray-900 mb-2">Termos e Condições</h1>
        <p className="text-sm text-gray-400 mb-10">Última atualização: julho de 2025</p>

        <div className="prose prose-gray max-w-none space-y-8 text-sm text-gray-700 leading-relaxed">

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">1. Identificação da empresa</h2>
            <p>
              <strong>Noisy Phocus, Lda.</strong>, que opera sob a marca <strong>Arco-Íris da Pequenada</strong>,
              com sede na Avenida da Guarda Inglesa, Lote E, Coimbra, NIF 518942120.
              Contacto:{' '}
              <a href="mailto:geral.arcoirisdapequenada@gmail.com" className="text-blue-600 underline">
                geral.arcoirisdapequenada@gmail.com
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">2. Objeto e âmbito</h2>
            <p>
              Os presentes Termos e Condições regulam o acesso e a utilização da plataforma online do
              Arco-Íris da Pequenada e a contratação dos seguintes serviços:
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li><strong>Sala de Estudo</strong> — apoio escolar em regime de subscrição mensal</li>
              <li><strong>Transporte Escolar</strong> — serviço de transporte em regime de subscrição mensal</li>
              <li><strong>Festas de Aniversário</strong> — reserva pontual de festas</li>
              <li><strong>Campos de Férias</strong> — inscrição em campos de Natal e/ou Verão</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">3. Registo e conta</h2>
            <p>
              Para aceder à área de clientes e contratar serviços, é necessário criar uma conta com um
              endereço de email válido. O titular da conta é responsável pela veracidade dos dados
              fornecidos e pela confidencialidade das suas credenciais de acesso.
            </p>
            <p className="mt-2">
              A criação de conta implica a aceitação integral dos presentes Termos e Condições e da
              Política de Privacidade.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">4. Serviços por subscrição</h2>

            <h3 className="font-semibold text-gray-700 mt-4 mb-1">4.1. Ativação</h3>
            <p>
              A subscrição torna-se ativa após aprovação pela equipa do Arco-Íris da Pequenada e confirmação
              do primeiro pagamento. O início de prestação do serviço depende da disponibilidade de vagas.
            </p>

            <h3 className="font-semibold text-gray-700 mt-4 mb-1">4.2. Faturação</h3>
            <p>
              As subscrições mensais são cobradas no início de cada mês. As faturas são emitidas
              eletronicamente e enviadas para o email registado. O pagamento pode ser efetuado via
              MB WAY, referência Multibanco ou cartão de crédito/débito, através da plataforma Easypay.
            </p>

            <h3 className="font-semibold text-gray-700 mt-4 mb-1">4.3. Cancelamento</h3>
            <p>
              O cliente pode cancelar a subscrição a qualquer momento através da área de clientes ou
              por email. O cancelamento produz efeitos no final do mês em curso, não havendo lugar a
              reembolso proporcional. O serviço continua disponível até ao final do período já pago.
            </p>

            <h3 className="font-semibold text-gray-700 mt-4 mb-1">4.4. Falta de pagamento</h3>
            <p>
              Em caso de pagamento em falta por 30 dias, reservamo-nos o direito de suspender o acesso
              ao serviço até regularização da situação.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">5. Reservas pontuais (festas)</h2>
            <p>
              A reserva de uma festa de aniversário requer o preenchimento do formulário e confirmação
              por parte da nossa equipa. A confirmação da reserva implica o pagamento de um sinal de
              50% do valor total. O valor remanescente é liquidado até 48 horas antes do evento.
            </p>
            <p className="mt-2">
              O cancelamento de uma festa com mais de 7 dias de antecedência implica a devolução integral
              do sinal. Cancelamentos com menos de 7 dias de antecedência não são reembolsáveis.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">6. Campos de férias</h2>
            <p>
              As inscrições em campos de férias estão sujeitas a disponibilidade de vagas. O valor é
              cobrado na totalidade no momento da inscrição. Cancelamentos com mais de 14 dias de
              antecedência têm direito a reembolso de 80%. Cancelamentos posteriores não são reembolsáveis.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">7. Responsabilidade e seguro</h2>
            <p>
              O Arco-Íris da Pequenada dispõe de seguro de acidentes pessoais para as crianças durante
              as atividades realizadas nas nossas instalações. A empresa não se responsabiliza por
              objetos pessoais perdidos ou danificados nas instalações.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">8. Propriedade intelectual</h2>
            <p>
              Todo o conteúdo da plataforma (textos, imagens, logótipos, software) é propriedade da
              Noisy Phocus, Lda., protegido por direitos de autor e demais legislação aplicável.
              É proibida a reprodução total ou parcial sem autorização prévia e escrita.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">9. Alterações aos termos</h2>
            <p>
              Reservamo-nos o direito de alterar os presentes Termos e Condições a qualquer momento.
              Alterações serão comunicadas por email com 15 dias de antecedência. A continuação da
              utilização dos serviços após essa data implica a aceitação das alterações.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-2">10. Lei aplicável e foro</h2>
            <p>
              Os presentes Termos e Condições são regidos pela lei portuguesa. Em caso de litígio,
              as partes elegem o Tribunal da Comarca de Coimbra como competente, sem prejuízo do
              direito do consumidor a recorrer a mecanismos de Resolução Alternativa de Litígios (RAL).
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}
