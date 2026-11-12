import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { isAndroidWebView } from "../lib/androidImeInput";
import { useSessionStore } from "../stores/useSessionStore";
import { useSftpStore } from "../stores/useSftpStore";
import { useTunnelStore } from "../stores/useTunnelStore";

/**
 * Android: run the keep-alive foreground service exactly while something
 * holds a network session (a remote terminal tab, an SFTP connection or an
 * active tunnel). Android freezes a backgrounded app after about a minute
 * and drops its sockets; the service prevents that, at the cost of an
 * ongoing notification, so it must not outlive the sessions.
 *
 * The notification says what is connected ("2 SSH sessions · SFTP ·
 * 1 tunnel") and is refreshed whenever that changes. It carries counts
 * only, never host names: notifications can show on the lock screen.
 */
export function useSessionKeepAlive(): void {
  const { t } = useTranslation();
  const sshCount = useSessionStore(
    (s) => s.tabs.filter((tab) => !tab.isLocal && !tab.id.startsWith("local-")).length,
  );
  const hasSftp = useSftpStore((s) => Boolean(s.leftSessionId || s.rightSessionId));
  const tunnelCount = useTunnelStore((s) => s.activeRuleIds.size);

  const active = sshCount > 0 || hasSftp || tunnelCount > 0;
  const summary = [
    sshCount > 0 ? t("common.keepAliveSsh", { count: sshCount }) : null,
    hasSftp ? t("common.keepAliveSftp") : null,
    tunnelCount > 0 ? t("common.keepAliveTunnel", { count: tunnelCount }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = t("common.keepAliveTitle");

  useEffect(() => {
    if (!isAndroidWebView()) return;
    api
      .setSessionKeepAlive(active, active ? { title, summary } : null)
      .catch((e) => console.error("keep-alive service:", e));
  }, [active, title, summary]);
}
