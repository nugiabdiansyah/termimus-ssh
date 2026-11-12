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
 * - Publishes the visual viewport's offset as `--app-top`. With the keyboard
 *   open the visible area is smaller than the layout viewport, so the browser
 *   lets the user pan it with a swipe; the app shell (sized to the visible
 *   area) would slide off the top and leave a blank band above the keyboard.
 *   The shell is pinned at `--app-top` so it follows the visible area.
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
    root.style.setProperty("--app-top", `${Math.round(viewport?.offsetTop ?? 0)}px`);
    root.classList.toggle("kb-open", window.innerHeight - height > KEYBOARD_MIN_HEIGHT);
    // Focusing an input can scroll the layout viewport under the keyboard;
    // the app shell is sized to the visible area, so it must stay at the top.
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };

  installPagePanGuard();

  update();
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  window.addEventListener("resize", update);
}

/**
 * Can `el` scroll natively along `axis` in the direction of this drag?
 * `delta` is how far the finger moved: dragging towards the start (negative)
 * reveals content further on, so it needs room after the current offset;
 * dragging the other way needs room before it.
 */
function canScroll(el: Element, axis: "x" | "y", delta: number): boolean {
  const style = getComputedStyle(el);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (overflow !== "auto" && overflow !== "scroll") return false;
  const offset = axis === "y" ? el.scrollTop : el.scrollLeft;
  const max = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  return delta < 0 ? offset < max - 1 : offset > 1;
}

/**
 * Stop touch drags from panning the page.
 *
 * With the soft keyboard open the visible area is smaller than the page, so
 * a drag that no scroller consumes pans the whole app: the header slides
 * under the status bar and a blank band opens above the keyboard. A drag is
 * let through only if something under the finger can still scroll natively
 * in the drag's direction; everything else is cancelled, including a drag on
 * a list that is already at its end (which would otherwise hand the scroll
 * up to the page). The browser keeps a gesture on the scroller it started
 * with, so deciding once per gesture is enough. The terminal is unaffected:
 * it scrolls its buffer from its own touch handlers, not natively.
 */
function installPagePanGuard(): void {
  let startX = 0;
  let startY = 0;
  // Decided on the first move of each gesture, then held until the next touchstart.
  let allow: boolean | null = null;

  document.addEventListener(
    "touchstart",
    (e) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      allow = e.touches.length > 1 ? false : null;
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (allow === null) {
        const touch = e.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        const axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
        const delta = axis === "y" ? dy : dx;
        allow = false;
        for (let el = e.target as Element | null; el && el !== document.documentElement; el = el.parentElement) {
          if (el !== document.body && canScroll(el, axis, delta)) {
            allow = true;
            break;
          }
        }
      }
      if (!allow && e.cancelable) e.preventDefault();
    },
    { passive: false, capture: true },
  );
}

