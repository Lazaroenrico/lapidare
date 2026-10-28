"use client";

import React from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import { bannerFor, type UpdateState } from "@/lib/updates";
import { useLocale } from "./locale-provider";
import { useUpdateState } from "./use-update-state";

/** Presentational strip: no window access, so it renders in tests. Not dismissable (the update applies on quit). */
export function UpdateBannerView({
  state,
  locale,
  onRestart,
  onOpenRelease,
}: {
  state: UpdateState | null | undefined;
  locale: string;
  onRestart: () => void;
  onOpenRelease: () => void;
}) {
  const spec = bannerFor(state, locale);
  if (!spec) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1 font-ui text-[11px] leading-5 text-muted-foreground"
    >
      <Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-foreground">{spec.message}</span>
      <button
        type="button"
        onClick={spec.kind === "restart" ? onRestart : onOpenRelease}
        className="cursor-pointer rounded-md border border-foreground bg-foreground px-2 font-semibold text-background transition-colors hover:bg-foreground/90"
      >
        {spec.action}
      </button>
      <Link href="/settings" className="cursor-pointer underline hover:text-foreground">
        {spec.settingsLabel}
      </Link>
    </div>
  );
}

export function UpdateBanner() {
  const { locale } = useLocale();
  const { bridge, state } = useUpdateState();
  if (!bridge) return null;
  return (
    <UpdateBannerView
      state={state}
      locale={locale}
      onRestart={() => void bridge.updates.restart()}
      onOpenRelease={() => void bridge.updates.openRelease()}
    />
  );
}
