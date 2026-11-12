import { useState } from "react";
import { ChevronDown, X, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { useSessionStore, SshTab } from "../../stores/useSessionStore";
import { getAllSessionIdsInTree } from "../../lib/layoutTree";

interface MobileSessionSwitcherProps {
  /** Whether the terminal page is showing (to mark the active session). */
  isTerminalActive?: boolean;
  /** Bring the terminal page to the front after picking a session. */
  onSelectTab?: () => void;
}

/**
 * Mobile replacement for the header's session tabs.
 *
 * A row of tabs does not fit a phone: it scrolls sideways, hides most
 * sessions, and its desktop drag-to-split gesture fires on a long touch.
 * Instead the header shows one chip for the current session (tap to go to
 * it) with a count button beside it that opens a bottom sheet listing every
 * open session, where you can switch or close them.
 */
export function MobileSessionSwitcher({ isTerminalActive, onSelectTab }: MobileSessionSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { tabs, groups, activeGroupId, setActiveGroup, closeGroup } = useSessionStore(
    useShallow((s) => ({
      tabs: s.tabs,
      groups: s.groups,
      activeGroupId: s.activeGroupId,
      setActiveGroup: s.setActiveGroup,
      closeGroup: s.closeGroup,
    })),
  );

  const sessions = groups
    .map((group) => {
      const groupTabs = getAllSessionIdsInTree(group.rootPane)
        .map((id) => tabs.find((tab) => tab.id === id))
        .filter(Boolean) as SshTab[];
      if (groupTabs.length === 0) return null;
      const primary = groupTabs[0];
      const count = groupTabs.length;
      // Same naming as the header tabs: workspace label if any, else the host.
      const label = group.label ?? (count > 1 ? `${primary.hostLabel} (${count})` : primary.hostLabel);
      const state: "connecting" | "connected" | "disconnected" = groupTabs.some((tab) => tab.connecting)
        ? "connecting"
        : groupTabs.every((tab) => tab.connected)
        ? "connected"
        : "disconnected";
      return { id: group.id, label, address: primary.hostAddress, state };
    })
    .filter((session): session is NonNullable<typeof session> => session !== null);

  if (sessions.length === 0) return null;

  const dotClass = {
    connected: "bg-[var(--success)]",
    connecting: "bg-[var(--warning)] animate-pulse",
    disconnected: "bg-[var(--danger)]",
  };

  // The chip shows the session you were last in; fall back to the first one.
  const current = sessions.find((session) => session.id === activeGroupId) ?? sessions[0];

  return (
    <>
      <div
        className={`flex h-8 min-w-0 items-center rounded-lg border ${
          isTerminalActive
            ? "border-[var(--border-subtle)] bg-[var(--surface-high)]"
            : "border-transparent"
        }`}
      >
        <button
          type="button"
          onClick={() => {
            setActiveGroup(current.id);
            onSelectTab?.();
          }}
          className="flex h-full min-w-0 items-center gap-2 pl-2.5 pr-1.5"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass[current.state]}`} />
          <span
            className={`truncate font-mono text-xs ${
              isTerminalActive ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-secondary)]"
            }`}
          >
            {current.label}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={t("nav.sessions")}
          aria-label={t("nav.sessions")}
          className="flex h-full shrink-0 items-center gap-0.5 border-l border-[var(--border)] pl-1.5 pr-1.5 text-[var(--text-muted)] active:bg-[var(--surface-container)]"
        >
          <span className="font-mono text-[11px] font-semibold text-[var(--text-secondary)]">
            {sessions.length}
          </span>
          <ChevronDown size={14} />
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/60"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface-low)] pb-[env(safe-area-inset-bottom)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 pb-2 pt-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {t("nav.sessions")}
                <span className="ml-2 font-mono text-xs font-normal text-[var(--text-muted)]">
                  {sessions.length}
                </span>
              </h3>
              {/* First ✕ in the sheet: the Android Back handler clicks it to dismiss. */}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("common.close")}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] active:bg-[var(--surface-container)]"
              >
                <X size={18} />
              </button>
            </div>

            <div className="max-h-[55vh] overflow-y-auto px-2 pb-3">
              {sessions.map((session) => {
                const active = isTerminalActive && session.id === activeGroupId;
                return (
                  <div
                    key={session.id}
                    className={`flex items-center rounded-xl ${
                      active ? "bg-[var(--surface-high)]" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setActiveGroup(session.id);
                        onSelectTab?.();
                        setOpen(false);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left"
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass[session.state]}`} />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-sm ${
                            active ? "font-semibold text-[var(--primary)]" : "font-medium text-[var(--text-primary)]"
                          }`}
                        >
                          {session.label}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-[var(--text-muted)]">
                          {session.address}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => closeGroup(session.id)}
                      aria-label={t("nav.closeTab")}
                      className="mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] active:bg-[var(--danger)]/15 active:text-[var(--danger)]"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
