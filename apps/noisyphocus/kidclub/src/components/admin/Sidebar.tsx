import { NavLink } from 'react-router-dom';
import { useUser } from '@shared/hooks';
import SidebarSection from './SidebarSection';

function SidebarNavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `block py-2 px-4 rounded-md transition-colors duration-200 ${isActive ? 'bg-blue-100 text-blue-600' : 'text-gray-700 hover:bg-gray-100'}`
      }
    >
      {children}
    </NavLink>
  );
}

export default function Sidebar() {
  const user = useUser();

  if (!user) return null;

  return (
    <aside className="w-64 bg-white border-r border-gray-200 p-4 font-[Fredoka]">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-800">Arco-Íris</h1>
        <p className="text-sm text-gray-500">Painel de Administração</p>
      </div>
      <nav className="space-y-4">
        <SidebarSection title="📋 Inscrições" defaultOpen>
          <SidebarNavLink to="/admin/subscriptions">👨‍👩‍👧 Famílias e inscrições</SidebarNavLink>
        </SidebarSection>

        <SidebarSection title="🎉 Festas">
          <SidebarNavLink to="/admin/parties">🎈 Reservas</SidebarNavLink>
          <SidebarNavLink to="/admin/party-config">🛠️ Configuração</SidebarNavLink>
        </SidebarSection>

        <SidebarSection title="🏕️ Campos">
          <SidebarNavLink to="/admin/camps">🏕️ Campos</SidebarNavLink>
        </SidebarSection>

        <SidebarSection title="⚙️ Configuração">
          <SidebarNavLink to="/admin/financial-summary">📊 Resumo Financeiro</SidebarNavLink>
          <SidebarNavLink to="/admin/config/descontos">🏷️ Descontos</SidebarNavLink>
          <SidebarNavLink to="/admin/study-room-planner">📖 Planeador — Sala de Estudo</SidebarNavLink>
          <SidebarNavLink to="/admin/transport-planner">🗓️ Planeador — Transporte</SidebarNavLink>
        </SidebarSection>

        <SidebarSection title="⚙️ Operações">
          <SidebarNavLink to="/admin/calendar">📅 Calendário</SidebarNavLink>
          <SidebarNavLink to="/admin/billing">💶 Cobranças</SidebarNavLink>
          <SidebarNavLink to="/admin/email-center">✉️ Email Center</SidebarNavLink>
        </SidebarSection>

        <SidebarSection title="👥 Recursos Humanos">
          <SidebarNavLink to="/admin/hr">👥 Colaboradores</SidebarNavLink>
          <SidebarNavLink to="/admin/timesheets">⏰ Registo de Horas</SidebarNavLink>
        </SidebarSection>

        <SidebarSection title="🛠️ Admin">
          <SidebarNavLink to="/admin/data-management">🗄️ Gestão de Dados</SidebarNavLink>
          <SidebarNavLink to="/admin/client-errors">🚨 Erros dos clientes</SidebarNavLink>
        </SidebarSection>
      </nav>
    </aside>
  );
}
