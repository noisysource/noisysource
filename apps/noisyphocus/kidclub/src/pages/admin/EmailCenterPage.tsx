import { useState } from 'react';
import EmailComposer, { Draft } from './email/EmailComposer';
import EmailHistory from './email/EmailHistory';

/**
 * Admin email: compose a message with variables filled per family, pick the
 * families it goes to, send; then follow and resend from the history.
 */
export default function EmailCenterPage() {
  const [tab, setTab] = useState<'compose' | 'history'>('compose');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);

  const tabCls = (t: typeof tab) =>
    `px-4 py-2 text-sm font-medium border-b-2 ${tab === t ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`;

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-4">
      <h1 className="text-2xl font-bold text-gray-900">Emails</h1>
      <div className="flex border-b border-gray-200">
        <button className={tabCls('compose')} onClick={() => setTab('compose')}>Compor</button>
        <button className={tabCls('history')} onClick={() => setTab('history')}>Histórico</button>
      </div>
      {/* Kept mounted so switching tabs doesn't lose the message being written. */}
      <div className={tab === 'compose' ? '' : 'hidden'}>
        <EmailComposer draft={draft} draftVersion={draftVersion} />
      </div>
      {tab === 'history' && (
        <EmailHistory onDuplicate={d => { setDraft(d); setDraftVersion(v => v + 1); setTab('compose'); }} />
      )}
    </div>
  );
}
