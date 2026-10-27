"use client";

import { useEffect, useRef } from "react";
import { comboFor, KEYMAP_CHANGED_EVENT, loadKeymap, matchesCombo, type ShortcutId } from "@/lib/keyboard";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** True when the event comes from a field where typing must win over shortcuts. */
function fromEditable(event: KeyboardEvent): boolean {
  const el = event.target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/**
 * Bind `handler` to the shortcut `id` (registry in lib/keyboard.ts, user overrides from
 * Settings → Teclado). Plain-key shortcuts ("?", "F2") are ignored while typing in a field;
 * modifier combos and Escape still fire. Return `false` from the handler to let the event
 * through (no preventDefault).
 */
export function useShortcut(id: ShortcutId, handler: (event: KeyboardEvent) => boolean | void, enabled = true) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    let combo = comboFor(id, loadKeymap());
    const refresh = () => {
      combo = comboFor(id, loadKeymap());
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesCombo(event, combo, isMac())) return;
      const plain = !(event.metaKey || event.ctrlKey || event.altKey) && event.key !== "Escape";
      if (plain && fromEditable(event)) return;
      if (handlerRef.current(event) !== false) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(KEYMAP_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(KEYMAP_CHANGED_EVENT, refresh);
    };
  }, [id, enabled]);
}
