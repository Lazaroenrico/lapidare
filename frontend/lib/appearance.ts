/**
 * Settings → Aparência (pure: no DOM, no storage). Persisted per browser under
 * `learnharness:appearance`; callers do the storage access (inside try/catch) and the
 * DOM write (components/appearance-applier.tsx). Dark theme only: these settings
 * change typography, never the palette tokens.
 */

export const APPEARANCE_KEY = "learnharness:appearance";
export const APPEARANCE_CHANGED_EVENT = "learnharness:appearance-changed";

export const PROSE_SIZE_MIN = 14;
export const PROSE_SIZE_MAX = 20;
export const PROSE_SIZE_DEFAULT = 16;

export interface Appearance {
  /** Teaching prose size in px (14–20). */
  proseSize: number;
  /** Titles in CMU Serif (true) or in the prose sans (false). */
  serifTitles: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = { proseSize: PROSE_SIZE_DEFAULT, serifTitles: true };

/** Integer px within [14, 20]; anything non-numeric falls back to 16. */
export function clampProseSize(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return PROSE_SIZE_DEFAULT;
  return Math.min(PROSE_SIZE_MAX, Math.max(PROSE_SIZE_MIN, Math.round(n)));
}

export function normalizeAppearance(input: unknown): Appearance {
  const src = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  return {
    proseSize: "proseSize" in src ? clampProseSize(src.proseSize) : PROSE_SIZE_DEFAULT,
    serifTitles: typeof src.serifTitles === "boolean" ? src.serifTitles : DEFAULT_APPEARANCE.serifTitles,
  };
}

/** Stored JSON → appearance (null/corrupt → defaults). */
export function parseAppearance(raw: string | null | undefined): Appearance {
  if (!raw) return { ...DEFAULT_APPEARANCE };
  try {
    return normalizeAppearance(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export const serializeAppearance = (a: Appearance) => JSON.stringify(normalizeAppearance(a));

export const isDefaultAppearance = (a: Appearance) =>
  a.proseSize === DEFAULT_APPEARANCE.proseSize && a.serifTitles === DEFAULT_APPEARANCE.serifTitles;

/**
 * CSS custom properties to set on `:root`. `null` means "remove the inline override"
 * so the token from globals.css applies.
 */
export function appearanceVars(a: Appearance): Record<string, string | null> {
  const n = normalizeAppearance(a);
  return {
    "--prose-size": n.proseSize === PROSE_SIZE_DEFAULT ? null : `${n.proseSize}px`,
    "--font-title": n.serifTitles ? null : "var(--font-prose)",
  };
}
