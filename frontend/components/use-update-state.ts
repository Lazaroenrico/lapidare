"use client";

import { useEffect, useState } from "react";
import { getBridge, type LapidareBridge, type UpdateState } from "@/lib/updates";

/** Subscribes to the desktop bridge (push via onState, no polling). Null state outside the desktop app. */
export function useUpdateState(): { bridge: LapidareBridge | undefined; state: UpdateState | null } {
  const [bridge, setBridge] = useState<LapidareBridge | undefined>(undefined);
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const b = getBridge();
    setBridge(b);
    if (!b) return;
    let alive = true;
    b.updates.getState().then((s) => { if (alive) setState(s); }).catch(() => {});
    const off = b.updates.onState((s) => { if (alive) setState(s); });
    return () => { alive = false; off(); };
  }, []);
  return { bridge, state };
}
