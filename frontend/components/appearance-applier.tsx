"use client";

import { useEffect } from "react";
import { APPEARANCE_CHANGED_EVENT, APPEARANCE_KEY, appearanceVars, parseAppearance, type Appearance } from "@/lib/appearance";

export function readAppearance(): Appearance {
  try {
    return parseAppearance(window.localStorage.getItem(APPEARANCE_KEY));
  } catch {
    return parseAppearance(null);
  }
}

/** Writes the appearance variables on `:root` (inline overrides of the globals.css tokens). */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(appearanceVars(appearance))) {
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
}

/** Applies Settings → Aparência at app start and whenever it changes (this tab or another). */
export function AppearanceApplier() {
  useEffect(() => {
    const apply = () => applyAppearance(readAppearance());
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === APPEARANCE_KEY) apply();
    };
    apply();
    window.addEventListener(APPEARANCE_CHANGED_EVENT, apply);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(APPEARANCE_CHANGED_EVENT, apply);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return null;
}
