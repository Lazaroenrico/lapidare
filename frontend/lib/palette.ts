/**
 * Literal palette for contexts that cannot resolve CSS variables
 * (Canvas 2D drawing, Excalidraw appState, Next.js `themeColor` metadata).
 *
 * These values MUST mirror the tokens declared in `app/globals.css` (`:root`).
 * This is the only file besides `globals.css` allowed to contain hex literals
 * (enforced by `tests/tokens.test.cjs`).
 */
export const palette = {
  background: "#141414",
  card: "#1c1c1c",
  accent: "#2a2a2a",
  border: "#434343",
  foreground: "#e6e6e6",
  mutedForeground: "#8d8d8d",
  success: "#34d399",
  warning: "#e0a030",
  danger: "#f87171",
} as const;

export type PaletteToken = keyof typeof palette;

/** `rgba()` string for a palette token at the given alpha (0..1). */
export function withAlpha(token: PaletteToken, alpha: number): string {
  const hex = palette[token].slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
