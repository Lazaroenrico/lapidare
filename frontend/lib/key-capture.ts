/**
 * Settings → Teclado: turn the next key press into a combo string (pure).
 *
 * The produced combo round-trips through `parseCombo` and `matchesCombo` (lib/keyboard),
 * so whatever the learner presses while capturing is exactly what will fire later.
 */
import type { KeyLike } from "./keyboard";

export type CaptureResult =
  | { kind: "cancel" } // plain Escape
  | { kind: "pending" } // only a modifier so far: keep listening
  | { kind: "invalid" } // a key that cannot be a shortcut on its own
  | { kind: "combo"; combo: string };

const MODIFIER_KEYS = new Set(["shift", "control", "meta", "alt", "altgraph", "os", "capslock", "fn", "hyper", "super"]);
const UNUSABLE_KEYS = new Set(["dead", "unidentified", "process", " ", "spacebar"]);
// Editing/navigation keys that must keep their meaning unless a modifier is held.
const NEEDS_MODIFIER = new Set(["tab", "enter", "backspace", "delete"]);

const isSymbol = (key: string) => key.length === 1 && !/[a-z0-9]/i.test(key);

/** Combo for a key press. `isMac` decides which physical key "Mod" is (⌘ vs Ctrl). */
export function captureCombo(event: KeyLike, isMac: boolean): CaptureResult {
  const lower = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(lower)) return { kind: "pending" };
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const otherSystemKey = isMac ? event.ctrlKey : event.metaKey;
  if (lower === "escape" && !mod && !event.altKey && !event.shiftKey && !otherSystemKey) return { kind: "cancel" };
  if (UNUSABLE_KEYS.has(lower) || !event.key) return { kind: "invalid" };
  // Ctrl on macOS (or ⊞/Super elsewhere) cannot be expressed by the registry grammar.
  if (otherSystemKey) return { kind: "invalid" };
  if (NEEDS_MODIFIER.has(lower) && !mod && !event.altKey) return { kind: "invalid" };

  const symbol = isSymbol(event.key);
  const keyPart = event.key === "+" ? "Plus" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const parts = [mod && "Mod", event.altKey && "Alt", event.shiftKey && !symbol && "Shift", keyPart].filter(Boolean);
  return { kind: "combo", combo: parts.join("+") };
}
