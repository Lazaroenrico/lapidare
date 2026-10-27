"use client";

import { useEffect, useState } from "react";
import { comboFor, formatCombo, KEYMAP_CHANGED_EVENT, loadKeymap, type ShortcutId } from "@/lib/keyboard";

export const detectMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Effective keymap overrides + platform, read after mount (keeps SSR markup stable) and
 * refreshed on `KEYMAP_CHANGED_EVENT`.
 */
export function useKeymap() {
  const [state, setState] = useState<{ overrides: ReturnType<typeof loadKeymap>; isMac: boolean } | null>(null);
  useEffect(() => {
    const refresh = () => setState({ overrides: loadKeymap(), isMac: detectMac() });
    refresh();
    window.addEventListener(KEYMAP_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(KEYMAP_CHANGED_EVENT, refresh);
  }, []);
  return state;
}

/** Formatted effective combo for a shortcut ("⌘," / "Ctrl+,"), or "" before mount. */
export function useComboLabel(id: ShortcutId): string {
  const keymap = useKeymap();
  return keymap ? formatCombo(comboFor(id, keymap.overrides), keymap.isMac) : "";
}

/** Small `<kbd>` with the effective "Open settings" combo (sidebar link). */
export function SettingsComboHint() {
  const label = useComboLabel("settings");
  if (!label) return null;
  return <kbd className="ml-auto px-1 rounded border border-border text-[10px] text-muted-foreground font-ui">{label}</kbd>;
}
