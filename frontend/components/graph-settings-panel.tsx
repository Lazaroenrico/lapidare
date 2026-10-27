"use client";

import React from "react";
import { RotateCcw, X } from "lucide-react";
import {
  DEFAULT_GRAPH_SETTINGS,
  GRAPH_SETTING_KEYS,
  GRAPH_SETTING_RANGES,
  isDefaultSettings,
  withSetting,
  type GraphSettingKey,
  type GraphSettings,
} from "@/lib/graph-settings";
import { useLocale } from "./locale-provider";

interface GraphSettingsPanelProps {
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  onClose: () => void;
}

const decimals = (step: number) => (String(step).split(".")[1] ?? "").length;

/** ⚙ panel: display + physics sliders (values clamped by lib/graph-settings). */
export function GraphSettingsPanel({ settings, onChange, onClose }: GraphSettingsPanelProps) {
  const { t } = useLocale();

  const row = (key: GraphSettingKey) => {
    const r = GRAPH_SETTING_RANGES[key];
    const id = `graph-setting-${key}`;
    return (
      <div key={key} className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
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
          onChange={(e) => onChange(withSetting(settings, key, Number(e.target.value)))}
          className="w-full accent-foreground cursor-pointer"
        />
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-label={t.graphSettingsTitle}
      className="absolute top-full right-0 mt-2 w-72 max-h-[70vh] overflow-y-auto bg-card border border-border rounded-lg shadow-2xl p-3 z-40 font-ui text-[11px] text-muted-foreground"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-foreground font-semibold">{t.graphSettingsTitle}</span>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-accent hover:text-foreground cursor-pointer"
          title={t.close}
          aria-label={t.close}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {(["display", "physics"] as const).map((group) => (
        <section key={group} className="mb-3">
          <h4 className="uppercase tracking-wider text-[10px] mb-2">{group === "display" ? t.gsDisplay : t.gsPhysics}</h4>
          <div className="flex flex-col gap-2.5">
            {GRAPH_SETTING_KEYS.filter((k) => GRAPH_SETTING_RANGES[k].group === group).map(row)}
          </div>
        </section>
      ))}
      <button
        type="button"
        disabled={isDefaultSettings(settings)}
        onClick={() => onChange({ ...DEFAULT_GRAPH_SETTINGS })}
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border border-border bg-accent hover:bg-border text-foreground cursor-pointer disabled:cursor-not-allowed disabled:text-muted-foreground disabled:bg-background"
      >
        <RotateCcw className="w-3 h-3" />
        {t.gsReset}
      </button>
    </div>
  );
}
