import { useEffect, useRef, useState } from "react";
import { Bell, Check, CheckCheck, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { AppNotification, NotificationSeverity } from "@shared/models/AppNotification";
import { api } from "../lib/api";

const SEVERITY_COLOR: Record<NotificationSeverity, string> = {
  info:    "border-blue-500/40 bg-blue-950/20",
  warning: "border-amber-500/40 bg-amber-950/20",
  urgent:  "border-red-500/40 bg-red-950/20",
};

const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  info:    "bg-blue-500",
  warning: "bg-amber-500",
  urgent:  "bg-red-500",
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const unread = notifications.filter(n => !n.read).length;

  async function reload() {
    try {
      setNotifications(await api.notifications.list());
    } catch {
      // silently ignore
    }
  }

  useEffect(() => { void reload(); }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    function onClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClickOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClickOutside);
    };
  }, [open]);

  async function handleClickNotif(n: AppNotification) {
    if (!n.read) {
      await api.notifications.markRead(n.id);
      setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
    }
    if (n.linkTo) {
      setOpen(false);
      navigate(n.linkTo);
    }
  }

  async function markAll() {
    await api.notifications.markAllRead();
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }

  return (
    <>
      <button
        onClick={() => { setOpen(v => !v); if (!open) void reload(); }}
        className="relative p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
        aria-label="Notificações"
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="fixed top-0 bottom-0 z-40 flex flex-col bg-zinc-900 border-r border-zinc-800 shadow-xl"
          style={{ left: 240, width: 320 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
            <span className="text-sm font-semibold text-zinc-100">Notificações</span>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button
                  onClick={markAll}
                  className="text-xs text-zinc-400 hover:text-zinc-100 flex items-center gap-1"
                  title="Marcar todas como lidas"
                >
                  <CheckCheck size={13} /> Marcar todas
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-200"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="text-center text-zinc-600 text-sm py-12">
                Sem notificações
              </div>
            ) : (
              <div className="divide-y divide-zinc-800">
                {notifications.map(n => (
                  <div
                    key={n.id}
                    onClick={() => handleClickNotif(n)}
                    className={`px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors border-l-2 ${SEVERITY_COLOR[n.severity]} ${n.read ? "opacity-50" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${n.read ? "bg-zinc-600" : SEVERITY_DOT[n.severity]}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-zinc-100 leading-tight">{n.title}</div>
                        <div className="text-xs text-zinc-400 mt-0.5 leading-snug">{n.body}</div>
                        {n.dueDate && (
                          <div className="text-[10px] text-zinc-600 mt-1">{n.dueDate}</div>
                        )}
                      </div>
                      {!n.read && n.linkTo && (
                        <Check size={11} className="text-zinc-600 mt-1 shrink-0" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
