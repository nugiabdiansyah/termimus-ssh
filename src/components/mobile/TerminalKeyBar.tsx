import type { Terminal } from "@xterm/xterm";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useMobileKeysStore } from "../../lib/mobileKeys";

interface TerminalKeyBarProps {
  termRef: RefObject<Terminal | null>;
}

type Key = { label: ReactNode; title: string } & (
  | { seq: string }
  | { arrow: "A" | "B" | "C" | "D" }
  | { ctrl: true }
);

const KEYS: Key[] = [
  { label: "Esc", title: "Escape", seq: "\x1b" },
  { label: "Tab", title: "Tab", seq: "\t" },
  { label: "Ctrl", title: "Ctrl (applies to the next key)", ctrl: true },
  { label: <ArrowLeft size={15} />, title: "Left", arrow: "D" },
  { label: <ArrowDown size={15} />, title: "Down", arrow: "B" },
  { label: <ArrowUp size={15} />, title: "Up", arrow: "A" },
  { label: <ArrowRight size={15} />, title: "Right", arrow: "C" },
  { label: "/", title: "Slash", seq: "/" },
  { label: "-", title: "Dash", seq: "-" },
  { label: "|", title: "Pipe", seq: "|" },
  { label: "~", title: "Tilde", seq: "~" },
];

/**
 * Row of keys a soft keyboard lacks (Esc, Tab, Ctrl, arrows, shell
 * punctuation), docked under the terminal so it sits right above the
 * keyboard. Buttons never take focus: stealing it from xterm's textarea
 * would dismiss the keyboard on every tap.
 */
export function TerminalKeyBar({ termRef }: TerminalKeyBarProps) {
  const ctrl = useMobileKeysStore((s) => s.ctrl);
  const toggleCtrl = useMobileKeysStore((s) => s.toggleCtrl);

  const press = (key: Key) => {
    const term = termRef.current;
    if ("ctrl" in key) {
      toggleCtrl();
      return;
    }
    if (!term) return;
    if ("arrow" in key) {
      // Full-screen apps (vim, htop) switch the cursor keys to application mode.
      const prefix = term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
      term.input(prefix + key.arrow, true);
      return;
    }
    term.input(key.seq, true);
  };

  return (
    <div className="absolute inset-x-0 bottom-0 flex h-10 items-stretch gap-1 overflow-x-auto border-t border-[var(--border)] bg-[var(--surface-low)] px-1 py-1 select-none">
      {KEYS.map((key) => {
        const armed = "ctrl" in key && ctrl;
        return (
          <button
            key={key.title}
            type="button"
            tabIndex={-1}
            title={key.title}
            aria-pressed={"ctrl" in key ? ctrl : undefined}
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press(key)}
            className={`flex min-w-10 shrink-0 grow items-center justify-center rounded-md px-2 font-mono text-[13px] transition-colors ${
              armed
                ? "bg-[var(--primary)] text-[var(--on-primary)] font-semibold"
                : "bg-[var(--surface-high)] text-[var(--text-primary)] active:bg-[var(--surface-highest)]"
            }`}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}
