/**
 * Sidebar presentation (pure). Wide viewports keep the desktop behaviour: a 260px column
 * or, when the learner collapsed it (persisted), a 56px rail. Narrow viewports (< 768px,
 * Tailwind `md`) turn the sidebar into an off-canvas drawer: closed by default, opened by
 * the ☰ button in the page headers, always shown in full (the rail makes no sense there).
 */

/** Matches Tailwind's `max-md` breakpoint. */
export const NARROW_QUERY = "(max-width: 767px)";

/** Window CustomEvent sent by the ☰ buttons; the single Sidebar listens to it. */
export const TOGGLE_NAV_DRAWER_EVENT = "learnharness:toggle-nav-drawer";

export interface SidebarPresentation {
  /** "rail" = collapsed 56px column; "full" = 260px panel (column or drawer). */
  variant: "rail" | "full";
  /** Off-canvas drawer (narrow viewport). */
  drawer: boolean;
  /** Drawer visible over the content (always false outside drawer mode). */
  open: boolean;
}

export function sidebarPresentation(narrow: boolean, collapsed: boolean, drawerOpen: boolean): SidebarPresentation {
  if (narrow) return { variant: "full", drawer: true, open: drawerOpen };
  return { variant: collapsed ? "rail" : "full", drawer: false, open: false };
}

/** What the "toggle sidebar" shortcut (⌘B) does in each presentation. */
export function toggleSidebarAction(narrow: boolean): "drawer" | "collapse" {
  return narrow ? "drawer" : "collapse";
}
