import { CalendarDays, CheckSquare, FolderGit2, Landmark, TrendingUp } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export function AuthScreen() {
  const { signInWithGoogle, signingIn, authError } = useAuth();

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100 flex items-center justify-center px-6 py-12">
      <div className="max-w-4xl w-full grid grid-cols-1 lg:grid-cols-12 bg-[#0F172A] border border-slate-800 rounded-xl overflow-hidden">
        <div className="lg:col-span-7 p-8 lg:p-10 border-b lg:border-b-0 lg:border-r border-slate-800 space-y-8">
          <div className="space-y-3">
            <p className="text-xs font-medium text-blue-400 tracking-wide">
              Strata Treasury
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-50 [text-wrap:balance]">
              Unified company and personal financial control
            </h1>
            <p className="text-sm text-slate-400 leading-relaxed max-w-md">
              Consolidate operating companies and personal accounts in a single analytical cockpit with Portuguese tax engines (IVA, IRS, IRC), live debt schedules, 12-month projections, and Gmail/Drive invoice reconciliation.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-2 border-t border-slate-800/80">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-slate-200 text-sm font-medium">
                <FolderGit2 className="w-4 h-4 text-blue-400 shrink-0" />
                <span>Gmail &amp; Drive Invoices</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Scan invoice emails, file PDFs into structured Drive folders, and link them to bank lines.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-slate-200 text-sm font-medium">
                <Landmark className="w-4 h-4 text-blue-400 shrink-0" />
                <span>Credits &amp; Taxes</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Track loan amortization alongside automated IVA, IRS, and IRC computations.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-slate-200 text-sm font-medium">
                <CalendarDays className="w-4 h-4 text-blue-400 shrink-0" />
                <span>Payroll &amp; Benefits</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Schedule salaries on the last workable day and statutory taxes on the 20th.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-slate-200 text-sm font-medium">
                <CheckSquare className="w-4 h-4 text-blue-400 shrink-0" />
                <span>Bank Reconciliation</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Import CSV, PDF, or image statements and match entries directly to Drive invoices.
              </p>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5 p-8 lg:p-10 flex flex-col justify-between bg-[#111827]">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-slate-100">Sign in to your workspace</h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Your entities, tax calculations, and reconciliations are isolated privately under your Google account. Invoice files stay in your own Google Drive, and Workspace session tokens are kept in memory only.
            </p>
          </div>

          <div className="space-y-4 my-8">
            {authError && (
              <div className="p-3 bg-rose-950/50 border border-rose-800/70 rounded-lg text-xs text-rose-200">
                {authError}
              </div>
            )}
            <button
              type="button"
              onClick={signInWithGoogle}
              disabled={signingIn}
              className="w-full flex items-center justify-center gap-3 px-4 py-2.5 bg-white hover:bg-slate-100 disabled:opacity-60 text-[#1F1F1F] border border-slate-300 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <svg
                version="1.1"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 48 48"
                className="w-4 h-4 shrink-0 block"
                aria-hidden="true"
              >
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                />
                <path
                  fill="#4285F4"
                  d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                />
              </svg>
              <span>{signingIn ? 'Connecting to Google...' : 'Sign in with Google'}</span>
            </button>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-500 leading-relaxed">
            <TrendingUp className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span>Private multi-entity cockpit · Zero local token storage · Direct Drive filing</span>
          </div>
        </div>
      </div>
    </div>
  );
}
