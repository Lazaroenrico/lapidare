/**
 * Keyboard shortcut registry (pure: no React, storage access guarded).
 *
 * Every global shortcut has a stable id, a default combo and a scope. Components bind
 * handlers through `useShortcut(id, handler)` (components/use-shortcut.ts); Settings →
 * Teclado rebinds by writing overrides to localStorage (`learnharness:keymap`).
 *
 * Combo grammar: modifiers joined by "+", then the key, e.g. "Mod+K", "Mod+Shift+F",
 * "Escape", "F2", "?". "Mod" is ⌘ on macOS and Ctrl elsewhere.
 */

export type ShortcutScope = "global" | "home" | "session";

export interface ShortcutDef {
  id: ShortcutId;
  combo: string;
  scope: ShortcutScope;
}

export const SHORTCUTS = [
  { id: "help", combo: "?", scope: "global" },
  { id: "settings", combo: "Mod+,", scope: "global" },
  { id: "newSession", combo: "Mod+N", scope: "global" },
  { id: "toggleSidebar", combo: "Mod+B", scope: "global" },
  { id: "sessionSearch", combo: "Mod+Shift+F", scope: "global" },
  { id: "goGraph", combo: "Mod+G", scope: "global" },
  { id: "dictate", combo: "Mod+D", scope: "global" },
  { id: "modelPicker", combo: "Mod+K", scope: "global" },
  { id: "find", combo: "Mod+F", scope: "session" },
  { id: "rename", combo: "F2", scope: "session" },
  { id: "abort", combo: "Escape", scope: "session" },
  { id: "toggleThinking", combo: "Mod+T", scope: "session" },
  { id: "continueTrack", combo: "Mod+Enter", scope: "home" },
] as const satisfies readonly { id: string; combo: string; scope: ShortcutScope }[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

export const KEYMAP_STORAGE_KEY = "learnharness:keymap";

export interface ParsedCombo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string; // lower-cased KeyboardEvent.key ("k", "escape", "f2", "?", ",")
}

export function parseCombo(combo: string): ParsedCombo | null {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  // "Mod++" style is not supported; a literal "+" key is written "Plus".
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  for (const m of mods) if (!["mod", "shift", "alt"].includes(m)) return null;
  return {
    mod: mods.has("mod"),
    shift: mods.has("shift"),
    alt: mods.has("alt"),
    key: key.toLowerCase() === "plus" ? "+" : key.toLowerCase(),
  };
}

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Whether a keyboard event matches a combo. `isMac` picks ⌘ vs Ctrl for "Mod". */
export function matchesCombo(event: KeyLike, combo: string, isMac: boolean): boolean {
  const parsed = parseCombo(combo);
  if (!parsed) return false;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (parsed.mod !== mod || parsed.alt !== event.altKey) return false;
  const key = event.key.toLowerCase();
  // Shifted symbols ("?") already encode Shift in the key itself.
  const symbol = key.length === 1 && !/[a-z0-9]/.test(key);
  if (!symbol && parsed.shift !== event.shiftKey) return false;
  return key === parsed.key;
}

/** Human label for a combo, e.g. "⌘⇧F" on macOS or "Ctrl+Shift+F" elsewhere. */
export function formatCombo(combo: string, isMac: boolean): string {
  const parsed = parseCombo(combo);
  if (!parsed) return combo;
  const keyLabel = parsed.key === "escape" ? "Esc" : parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key.toUpperCase();
  if (isMac) {
    return `${parsed.mod ? "⌘" : ""}${parsed.alt ? "⌥" : ""}${parsed.shift ? "⇧" : ""}${keyLabel}`;
  }
  return [parsed.mod && "Ctrl", parsed.alt && "Alt", parsed.shift && "Shift", keyLabel].filter(Boolean).join("+");
}

/** Overrides from storage; unknown ids and invalid combos are dropped. */
export function sanitizeKeymap(raw: unknown): Partial<Record<ShortcutId, string>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const ids = new Set<string>(SHORTCUTS.map((s) => s.id));
  const out: Partial<Record<ShortcutId, string>> = {};
  for (const [id, combo] of Object.entries(raw)) {
    if (ids.has(id) && typeof combo === "string" && parseCombo(combo)) out[id as ShortcutId] = combo;
  }
  return out;
}

export function loadKeymap(): Partial<Record<ShortcutId, string>> {
  try {
    const text = globalThis.localStorage?.getItem(KEYMAP_STORAGE_KEY);
    return text ? sanitizeKeymap(JSON.parse(text)) : {};
  } catch {
    return {};
  }
}

export function saveKeymap(map: Partial<Record<ShortcutId, string>>): void {
  try {
    globalThis.localStorage?.setItem(KEYMAP_STORAGE_KEY, JSON.stringify(sanitizeKeymap(map)));
  } catch {
    // Storage unavailable (private window, blocked site data): defaults still work.
  }
}

/** Effective combo for an id: the stored override, else the default. */
export function comboFor(id: ShortcutId, overrides: Partial<Record<ShortcutId, string>> = loadKeymap()): string {
  return overrides[id] ?? SHORTCUTS.find((s) => s.id === id)!.combo;
}

/** Ids whose effective combos collide (same combo in overlapping scopes). */
export function conflicts(overrides: Partial<Record<ShortcutId, string>>): ShortcutId[][] {
  const groups = new Map<string, ShortcutDef[]>();
  for (const def of SHORTCUTS) {
    const parsed = parseCombo(comboFor(def.id, overrides));
    if (!parsed) continue;
    const key = JSON.stringify(parsed);
    groups.set(key, [...(groups.get(key) ?? []), { ...def, combo: comboFor(def.id, overrides) }]);
  }
  const out: ShortcutId[][] = [];
  for (const defs of groups.values()) {
    const overlapping = defs.filter((d, _, all) =>
      all.some((o) => o !== d && (o.scope === d.scope || o.scope === "global" || d.scope === "global")));
    if (overlapping.length > 1) out.push(overlapping.map((d) => d.id));
  }
  return out;
}

export const KEYMAP_CHANGED_EVENT = "learnharness:keymap-changed";
