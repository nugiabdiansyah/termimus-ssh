import { useEffect, useRef, useState } from "react";
import { exit, onBackButtonPress } from "@tauri-apps/api/app";
import { isMobile } from "../lib/platform";
import type { ActiveTab } from "../components/layout/Sidebar";

/** Second press must land within this window to leave the app. */
const EXIT_CONFIRM_MS = 2000;
/** How long a dismissed overlay gets to unmount before we treat it as stuck. */
const DISMISS_SETTLE_MS = 150;

/** Topmost visible full-screen overlay (modal backdrop), if any. */
function topOverlay(): HTMLElement | null {
  const overlays = Array.from(document.querySelectorAll<HTMLElement>(".fixed.inset-0")).filter(
    (el) => {
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
    },
  );
  return overlays[overlays.length - 1] ?? null;
}

/** Ask an overlay to close the way a user would: its ✕ button, else Escape. */
function dismissOverlay(overlay: HTMLElement) {
  const closeButton = overlay.querySelector<HTMLButtonElement>("button:has(> svg.lucide-x)");
  if (closeButton && !closeButton.disabled) {
    closeButton.click();
    return;
  }
  for (const target of [document, window]) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  }
}

/**
 * Android system Back handling. Without this, Back closes the app outright,
 * killing every live SSH session. Order of precedence:
 *
 * 1. An open modal is dismissed.
 * 2. Any page other than Hosts (including the terminal) returns to Hosts;
 *    terminal sessions keep running in the background.
 * 3. On Hosts, a second press within two seconds exits; the first only
 *    shows a hint (returned as `exitHintVisible`).
 *
 * Overlays that cannot be dismissed (vault unlock, app lock) fall through to
 * step 3 so the user is never trapped in the app.
 */
export function useBackButton(activeNav: ActiveTab, goHome: () => void): { exitHintVisible: boolean } {
  const [exitHintVisible, setExitHintVisible] = useState(false);
  const activeNavRef = useRef(activeNav);
  const goHomeRef = useRef(goHome);
  activeNavRef.current = activeNav;
  goHomeRef.current = goHome;

  useEffect(() => {
    if (!isMobile) return;

    let lastExitPress = 0;
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let unregister: (() => void) | undefined;

    const confirmExit = () => {
      const now = Date.now();
      if (now - lastExitPress < EXIT_CONFIRM_MS) {
        void exit(0);
        return;
      }
      lastExitPress = now;
      setExitHintVisible(true);
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => setExitHintVisible(false), EXIT_CONFIRM_MS);
    };

    const handleBack = () => {
      const overlay = topOverlay();
      if (overlay) {
        dismissOverlay(overlay);
        setTimeout(() => {
          if (overlay.isConnected && topOverlay() === overlay) confirmExit();
        }, DISMISS_SETTLE_MS);
        return;
      }
      if (activeNavRef.current !== "hosts") {
        goHomeRef.current();
        return;
      }
      confirmExit();
    };

    onBackButtonPress(handleBack)
      .then((listener) => {
        if (disposed) void listener.unregister();
        else unregister = () => void listener.unregister();
      })
      .catch((e) => console.error("back button listener failed:", e));

    return () => {
      disposed = true;
      clearTimeout(hintTimer);
      unregister?.();
    };
  }, []);

  return { exitHintVisible };
}
