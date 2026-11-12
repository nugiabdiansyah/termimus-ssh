import { Server, KeyRound, FolderOpen, Braces, Waypoints, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTunnelStore } from "../../stores/useTunnelStore";
import type { ActiveTab } from "../layout/Sidebar";

interface MobileNavProps {
  activeNav: ActiveTab;
  onNavChange: (tab: ActiveTab) => void;
}

/**
 * Bottom navigation bar: the mobile counterpart of the desktop `Sidebar`.
 * Workspaces (multi-pane presets) are left out on purpose; split layouts do
 * not fit a phone screen.
 */
export function MobileNav({ activeNav, onNavChange }: MobileNavProps) {
  const { t } = useTranslation();
  const hasActiveTunnels = useTunnelStore((s) => s.activeRuleIds.size > 0);

  const items: { id: ActiveTab; icon: typeof Server; label: string; dot?: boolean }[] = [
    { id: "hosts", icon: Server, label: t("nav.short.hosts") },
    { id: "keychain", icon: KeyRound, label: t("nav.short.keychain") },
    { id: "sftp", icon: FolderOpen, label: t("nav.short.sftp") },
    { id: "snippets", icon: Braces, label: t("nav.short.snippets") },
    { id: "tunnels", icon: Waypoints, label: t("nav.short.tunnels"), dot: hasActiveTunnels },
    // No "update available" dot here: the update check looks at desktop
    // releases, which a phone cannot install.
    { id: "settings", icon: Settings, label: t("nav.short.settings") },
  ];

  return (
    <nav className="mobile-nav flex h-14 w-full shrink-0 items-stretch border-t border-[var(--border)] bg-[var(--surface-low)] select-none">
      {items.map(({ id, icon: Icon, label, dot }) => {
        const active = activeNav === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onNavChange(id)}
            aria-current={active ? "page" : undefined}
            className={`relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 transition-colors ${
              active ? "text-[var(--primary)]" : "text-[var(--text-muted)]"
            }`}
          >
            <span className="relative">
              <Icon size={20} />
              {dot && (
                <span className="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--secondary)]" />
              )}
            </span>
            <span className={`max-w-full truncate px-0.5 text-[10px] ${active ? "font-semibold" : "font-medium"}`}>
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
