"use client";

import { useSyncExternalStore } from "react";
import { Menu } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { NARROW_QUERY, TOGGLE_NAV_DRAWER_EVENT } from "@/lib/nav-drawer";

function subscribeNarrow(onChange: () => void): () => void {
  const mql = window.matchMedia(NARROW_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** True below the `md` breakpoint (false during SSR; CSS covers the first paint). */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/** ☰ for the page headers: only rendered on narrow viewports, opens the sidebar drawer. */
export function NavDrawerButton({ className = "" }: { className?: string }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(TOGGLE_NAV_DRAWER_EVENT))}
      className={`md:hidden p-1.5 text-muted-foreground hover:text-foreground hover:bg-card rounded cursor-pointer transition-colors shrink-0 ${className}`}
      title={t.openNav}
      aria-label={t.openNav}
      aria-haspopup="dialog"
    >
      <Menu className="w-4 h-4" />
    </button>
  );
}
