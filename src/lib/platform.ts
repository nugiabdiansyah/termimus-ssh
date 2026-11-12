/** True inside the Android / iOS app shells (Tauri mobile WebView). */
export const isMobile: boolean =
  typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** A soft keyboard is assumed open when it hides at least this much of the layout viewport. */
const KEYBOARD_MIN_HEIGHT = 120;

/**
 * Mobile viewport plumbing. Call once before the app renders.
 *
 * - Tags `<html>` with `is-mobile` so CSS can opt into mobile layout.
 * - Publishes the *visible* height as `--app-height`. Mobile WebViews draw
 *   edge-to-edge and do not shrink the layout viewport when the soft keyboard
 *   opens (`innerHeight` stays put, only `visualViewport.height` changes), so
 *   `100vh` would leave the bottom of the app, including the terminal prompt,
 *   underneath the keyboard.
 * - Tags `<html>` with `kb-open` while the keyboard is up.
 */
export function initMobileViewport(): void {
  if (!isMobile || typeof window === "undefined") return;

  const root = document.documentElement;
  root.classList.add("is-mobile");

  const viewport = window.visualViewport;
  const update = () => {
    const height = viewport?.height ?? window.innerHeight;
    root.style.setProperty("--app-height", `${Math.round(height)}px`);
    root.classList.toggle("kb-open", window.innerHeight - height > KEYBOARD_MIN_HEIGHT);
    // Focusing an input can scroll the layout viewport under the keyboard;
    // the app shell is sized to the visible area, so it must stay at the top.
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };

  update();
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  window.addEventListener("resize", update);
}
