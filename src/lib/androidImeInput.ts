import type { Terminal } from "@xterm/xterm";
import { applyStickyModifiers } from "./mobileKeys";

/**
 * Soft-keyboard input for xterm.js on Android WebView.
 *
 * Android IMEs report every key as `keydown` keyCode 229 and deliver the text
 * through `input`/composition events instead. xterm.js copes by snapshotting
 * its helper textarea on keydown and diffing it one `setTimeout(0)` later
 * (`CompositionHelper._handleAnyTextareaChanges`). The textarea is never
 * cleared, so when two keys land before the first timer fires each timer
 * re-sends the whole remaining suffix: typing `echo` fast reaches the shell
 * as `echchohoo`. On a remote root shell that is not a cosmetic bug.
 *
 * This adapter takes those events away from xterm (capture phase on the
 * terminal element, so they never reach xterm's own listeners on the
 * textarea) and forwards the text the events themselves carry, which is
 * exact regardless of timing. Composed text (predictive typing) is forwarded
 * incrementally as backspaces + new characters so the shell sees each
 * keystroke immediately rather than only when the word is committed.
 *
 * Real key events (Enter, Backspace on an empty field, hardware keyboards)
 * are left untouched and keep going through xterm's normal key handling.
 */

const DEL = "\x7f";
const IME_KEYCODE = 229;

export function isAndroidWebView(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

export function attachAndroidImeInput(term: Terminal): void {
  const root = term.element;
  const textarea = term.textarea;
  if (!root || !textarea) return;

  // What the shell has received so far for the composition in progress.
  let composed: string[] = [];

  const send = (data: string) => {
    if (data) term.input(data, true);
  };

  // Keep the helper textarea empty between inputs. Leftover text gives the
  // IME surrounding context to re-compose (e.g. backspacing into a previous
  // word), which would replay characters the shell already has.
  const reset = () => {
    composed = [];
    textarea.value = "";
  };

  const syncComposition = (next: string) => {
    const target = Array.from(next);
    let common = 0;
    while (
      common < composed.length &&
      common < target.length &&
      composed[common] === target[common]
    ) {
      common++;
    }
    send(DEL.repeat(composed.length - common) + target.slice(common).join(""));
    composed = target;
  };

  const claim = (e: Event) => e.stopPropagation();

  const onKey = (e: KeyboardEvent) => {
    if (e.keyCode === IME_KEYCODE) claim(e);
  };

  const onCompositionStart = (e: CompositionEvent) => {
    claim(e);
    composed = [];
  };

  const onCompositionUpdate = (e: CompositionEvent) => {
    claim(e);
    syncComposition(e.data ?? "");
  };

  const onCompositionEnd = (e: CompositionEvent) => {
    claim(e);
    syncComposition(e.data ?? "");
    reset();
  };

  const onInput = (e: Event) => {
    claim(e);
    const ev = e as InputEvent;
    // Composition text is handled by the composition events above. Decide
    // from the event itself, not from remembered state: some IMEs never fire
    // `compositionend`, and a stale "composing" flag would swallow all later
    // typing.
    if (ev.isComposing || ev.inputType === "insertCompositionText") return;

    switch (ev.inputType) {
      case "insertText":
      case "insertReplacementText":
        send(applyStickyModifiers(ev.data ?? ""));
        break;
      case "insertLineBreak":
      case "insertParagraph":
        send("\r");
        break;
      case "deleteContentBackward":
      case "deleteWordBackward":
        send(DEL);
        break;
      case "deleteContentForward":
        send("\x1b[3~");
        break;
      default:
        break;
    }
    reset();
  };

  root.addEventListener("keydown", onKey, true);
  root.addEventListener("keyup", onKey, true);
  root.addEventListener("compositionstart", onCompositionStart, true);
  root.addEventListener("compositionupdate", onCompositionUpdate, true);
  root.addEventListener("compositionend", onCompositionEnd, true);
  root.addEventListener("input", onInput, true);
}
