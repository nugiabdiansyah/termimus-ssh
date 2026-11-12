import { create } from "zustand";

/**
 * Sticky modifier state for the mobile terminal key bar. Soft keyboards have
 * no Ctrl key, so tapping "Ctrl" arms it and the next typed character is
 * sent as its control code (Ctrl then `c` → ETX).
 */
interface MobileKeysState {
  ctrl: boolean;
  toggleCtrl: () => void;
  clearCtrl: () => void;
}

export const useMobileKeysStore = create<MobileKeysState>((set) => ({
  ctrl: false,
  toggleCtrl: () => set((s) => ({ ctrl: !s.ctrl })),
  clearCtrl: () => set({ ctrl: false }),
}));

/** Control code for a single character, or null if it has none (e.g. digits). */
export function toControlCode(char: string): string | null {
  if (char.length !== 1) return null;
  const upper = char.toUpperCase();
  const code = upper.charCodeAt(0);
  // `@ A-Z [ \ ] ^ _` map to 0x00-0x1f; `?` is DEL by convention.
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
  if (upper === " ") return "\x00";
  if (upper === "?") return "\x7f";
  return null;
}

/**
 * Apply an armed Ctrl to typed text. Only a single typed character consumes
 * the modifier; anything longer (paste, word commit) passes through and
 * leaves it armed.
 */
export function applyStickyModifiers(data: string): string {
  const { ctrl, clearCtrl } = useMobileKeysStore.getState();
  if (!ctrl) return data;
  const control = toControlCode(data);
  if (control === null) return data;
  clearCtrl();
  return control;
}
