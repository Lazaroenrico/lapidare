"use client";

import React, { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  APPEARANCE_CHANGED_EVENT,
  APPEARANCE_KEY,
  DEFAULT_APPEARANCE,
  isDefaultAppearance,
  normalizeAppearance,
  PROSE_SIZE_MAX,
  PROSE_SIZE_MIN,
  serializeAppearance,
  type Appearance,
} from "@/lib/appearance";
import { settingsText } from "@/lib/settings-i18n";
import { useLocale } from "@/components/locale-provider";
import { applyAppearance, readAppearance } from "@/components/appearance-applier";
import { buttonClass, Card, SectionHeader, Switch } from "./ui";

/** Settings → Aparência: prose size and serif titles (localStorage, CSS variables on :root). */
export function AppearanceSection() {
  const { locale } = useLocale();
  const s = settingsText(locale);
  const [appearance, setAppearance] = useState<Appearance>({ ...DEFAULT_APPEARANCE });

  useEffect(() => setAppearance(readAppearance()), []);

  const update = (patch: Partial<Appearance>) => {
    const next = normalizeAppearance({ ...appearance, ...patch });
    setAppearance(next);
    try {
      window.localStorage.setItem(APPEARANCE_KEY, serializeAppearance(next));
    } catch {
      // Storage unavailable: applies to this page only.
    }
    applyAppearance(next);
    window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGED_EVENT));
  };

  return (
    <div className="space-y-6">
      <SectionHeader title={s.appearanceHeading} hint={s.appearanceHint} />
      <Card className="space-y-5">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="appearance-prose" className="font-ui text-xs font-semibold text-foreground">
              {s.proseSize}
            </label>
            <span className="font-ui text-xs text-foreground tabular-nums">{appearance.proseSize}px</span>
          </div>
          <input
            id="appearance-prose"
            type="range"
            min={PROSE_SIZE_MIN}
            max={PROSE_SIZE_MAX}
            step={1}
            value={appearance.proseSize}
            onChange={(e) => update({ proseSize: Number(e.target.value) })}
            className="w-full accent-foreground cursor-pointer"
          />
          <div className="flex justify-between font-ui text-[11px] text-muted-foreground">
            <span>{PROSE_SIZE_MIN}px</span>
            <span>{PROSE_SIZE_MAX}px</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="font-ui text-xs font-semibold text-foreground">{s.serifTitles}</div>
            <div className="text-xs text-muted-foreground">{s.serifTitlesHint}</div>
          </div>
          <Switch checked={appearance.serifTitles} label={s.serifTitles} onChange={(on) => update({ serifTitles: on })} />
        </div>
      </Card>

      <Card>
        <div className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{s.preview}</div>
        <h3 className="font-title text-lg text-foreground">{s.previewTitle}</h3>
        <p className="font-prose text-[length:var(--prose-size)] leading-[1.5] text-foreground">{s.previewBody}</p>
      </Card>

      <button
        type="button"
        disabled={isDefaultAppearance(appearance)}
        onClick={() => update({ ...DEFAULT_APPEARANCE })}
        className={buttonClass}
      >
        <RotateCcw className="w-3 h-3" />
        {s.restoreDefault}
      </button>
    </div>
  );
}
