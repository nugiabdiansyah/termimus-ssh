import { useEffect } from "react";
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
 */
export function useSessionKeepAlive(): void {
  const hasRemoteTab = useSessionStore((s) =>
    s.tabs.some((t) => !t.isLocal && !t.id.startsWith("local-")),
  );
  const hasSftp = useSftpStore((s) => Boolean(s.leftSessionId || s.rightSessionId));
  const hasTunnel = useTunnelStore((s) => s.activeRuleIds.size > 0);
  const active = hasRemoteTab || hasSftp || hasTunnel;

  useEffect(() => {
    if (!isAndroidWebView()) return;
    api.setSessionKeepAlive(active).catch((e) => console.error("keep-alive service:", e));
  }, [active]);
}
