"use client";

import React, { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  DEFAULT_GRAPH_SETTINGS,
  GRAPH_SETTING_KEYS,
  GRAPH_SETTING_RANGES,
  GRAPH_SETTINGS_KEY,
  isDefaultSettings,
  parseGraphSettings,
  serializeGraphSettings,
  withSetting,
  type GraphSettingKey,
  type GraphSettings,
} from "@/lib/graph-settings";
import { settingsText } from "@/lib/settings-i18n";
import { useLocale } from "@/components/locale-provider";
import { buttonClass, Card, SectionHeader } from "./ui";

const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;

/** Settings → Grafo: the ⚙ panel's display/physics settings, same localStorage key as the Home. */
export function GraphSection() {
  const { t, locale } = useLocale();
  const s = settingsText(locale);
  const [settings, setSettings] = useState<GraphSettings>({ ...DEFAULT_GRAPH_SETTINGS });

  useEffect(() => {
    try {
      setSettings(parseGraphSettings(window.localStorage.getItem(GRAPH_SETTINGS_KEY)));
    } catch {
      // Storage unavailable: defaults.
    }
  }, []);

  const update = (next: GraphSettings) => {
    setSettings(next);
    try {
      window.localStorage.setItem(GRAPH_SETTINGS_KEY, serializeGraphSettings(next));
    } catch {
      // Storage unavailable: keep the in-memory value only.
    }
  };

  const row = (key: GraphSettingKey) => {
    const r = GRAPH_SETTING_RANGES[key];
    const id = `settings-graph-${key}`;
    return (
      <div key={key} className="flex flex-col gap-1">
        <div className="flex items-center justify-between font-ui text-[11px] text-muted-foreground">
          <label htmlFor={id}>{t.gsLabels[key]}</label>
          <span className="text-foreground tabular-nums">{settings[key].toFixed(decimals(r.step))}</span>
        </div>
        <input
          id={id}
          type="range"
          min={r.min}
          max={r.max}
          step={r.step}
          value={settings[key]}
          onChange={(e) => update(withSetting(settings, key, Number(e.target.value)))}
          className="w-full accent-foreground cursor-pointer"
        />
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <SectionHeader title={s.graphHeading} hint={s.graphHint} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(["display", "physics"] as const).map((group) => (
          <Card key={group}>
            <h3 className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">
              {group === "display" ? t.gsDisplay : t.gsPhysics}
            </h3>
            <div className="flex flex-col gap-3">
              {GRAPH_SETTING_KEYS.filter((k) => GRAPH_SETTING_RANGES[k].group === group).map(row)}
            </div>
          </Card>
        ))}
      </div>
      <button
        type="button"
        disabled={isDefaultSettings(settings)}
        onClick={() => update({ ...DEFAULT_GRAPH_SETTINGS })}
        className={buttonClass}
      >
        <RotateCcw className="w-3 h-3" />
        {s.restoreDefault}
      </button>
    </div>
  );
}
