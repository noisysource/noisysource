// Pure part of the daily failed-action digest (clientErrorsDigest.ts), kept
// separate so it's testable without Firestore.

export interface ClientErrorReport {
  userId?: string;
  email?: string;
  impersonatingFamilyId?: string | null;
  action?: string;
  code?: string;
  message?: string;
  route?: string;
  createdAt?: Date;
}

export const DIGEST_MAX_ROWS = 30;

/**
 * Only failures a parent hit: not the admin area, not an admin impersonating a
 * family (the admin saw that one happen).
 */
export function parentFacing(reports: ClientErrorReport[]): ClientErrorReport[] {
  return reports.filter(r => !(r.route ?? '').startsWith('/admin') && !r.impersonatingFamilyId);
}

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const lisbonTime = (d?: Date) => d
  ? d.toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '';

export function buildDigest(reports: ClientErrorReport[], adminUrl: string): { subject: string; html: string } | null {
  if (reports.length === 0) return null;
  const people = new Set(reports.map(r => r.userId ?? r.email)).size;
  const subject = `[KidClub] ${reports.length} ${reports.length === 1 ? 'falha' : 'falhas'} de clientes nas últimas 24h (${people} ${people === 1 ? 'pessoa' : 'pessoas'})`;
  const rows = reports.slice(0, DIGEST_MAX_ROWS).map(r => `<tr>
<td style="padding:4px 8px;white-space:nowrap">${esc(lisbonTime(r.createdAt))}</td>
<td style="padding:4px 8px">${esc(r.email)}</td>
<td style="padding:4px 8px">${esc(r.action)}</td>
<td style="padding:4px 8px"><b>${esc(r.code)}</b> ${esc((r.message ?? '').slice(0, 160))}</td>
<td style="padding:4px 8px">${esc(r.route)}</td>
</tr>`).join('');
  const more = reports.length > DIGEST_MAX_ROWS ? `<p>… e mais ${reports.length - DIGEST_MAX_ROWS}.</p>` : '';
  const html = `<div style="font-family:Arial,sans-serif;font-size:13px">
<p>Ações de clientes que falharam nas últimas 24 horas. O cliente pode não ter visto nenhum erro.</p>
<table style="border-collapse:collapse" border="1" cellspacing="0">
<tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Erro</th><th>Página</th></tr>${rows}</table>
${more}<p><a href="${esc(adminUrl)}">Ver todas no painel</a></p></div>`;
  return { subject, html };
}
