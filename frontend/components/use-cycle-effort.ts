"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getModels } from "@/lib/api";
import { CYCLE_EFFORT_EVENT, registerCommandTarget } from "@/lib/command-events";
import { effortSelectable, nextEffort, pinnedEffort, type ModelChoice } from "@/lib/model-choice";
import type { EngineKind } from "@/lib/types";
import { useLocale } from "./locale-provider";

/**
 * Shift+Tab (`cycleEffort`): advances the effort of `value` and hands the new choice to
 * `apply`. Returns the text for an `aria-live="polite"` region ("Esforço: alto").
 * Pinned-effort ids need the catalog, fetched on first use and cached per engine.
 */
export function useCycleEffort({
  engine,
  value,
  apply,
  disabled = false,
}: {
  engine: EngineKind;
  value: ModelChoice;
  apply: (next: ModelChoice) => void;
  disabled?: boolean;
}): string {
  const { t } = useLocale();
  const [announcement, setAnnouncement] = useState("");
  const catalogRef = useRef<{ engine: EngineKind; models: { id: string; label?: string | null }[] } | null>(null);
  const stateRef = useRef({ engine, value, apply, disabled, t });
  stateRef.current = { engine, value, apply, disabled, t };
  const busyRef = useRef(false);

  const run = useCallback(async () => {
    const { engine, value, apply, t } = stateRef.current;
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      let models: { id: string; label?: string | null }[] = [];
      if (!effortSelectable(value.model)) {
        if (catalogRef.current?.engine !== engine) {
          const catalog = await getModels(engine).catch(() => null);
          const list = Array.isArray(catalog?.models) ? catalog.models : [];
          // Only a non-empty catalog is cached: a failed listing (agy timeout) retries next time.
          if (list.length > 0) catalogRef.current = { engine, models: list };
          models = list;
        } else {
          models = catalogRef.current.models;
        }
      }
      const next = nextEffort({ model_id: value.model, effort: value.effort }, models);
      if (!next) return;
      const effort = next.effort ?? value.effort;
      apply({ model: next.model_id, effort });
      const shown = next.effort ?? pinnedEffort(next.model_id) ?? "";
      setAnnouncement(`${t.slotEffort}: ${t.effortName(shown)}`);
    } finally {
      busyRef.current = false;
    }
  }, []);

  useEffect(
    () =>
      registerCommandTarget(CYCLE_EFFORT_EVENT, {
        run: () => void run(),
        eligible: () => !stateRef.current.disabled,
      }),
    [run],
  );

  return announcement;
}
