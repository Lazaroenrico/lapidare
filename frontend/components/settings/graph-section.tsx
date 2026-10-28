"use client";

import React, { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
  DEFAULT_GRAPH_SETTINGS,
  GRAPH_SETTING_GROUPS,
  GRAPH_SETTINGS_KEY,
  isDefaultSettings,
  parseGraphSettings,
  serializeGraphSettings,
  withSetting,
  type GraphSettings,
} from "@/lib/graph-settings";
import { getAgentSettings, putAgentSettings } from "@/lib/settings-api";
import { metersText } from "@/lib/meters-i18n";
import { settingsText } from "@/lib/settings-i18n";
import { useLocale } from "@/components/locale-provider";
import { GraphSettingControl, graphSettingKeys } from "@/components/graph-settings-panel";
import { buttonClass, Card, InlineStatus, SectionHeader, Switch } from "./ui";

/** Settings → Grafo: the ⚙ panel's settings, same localStorage key as the Home. */
export function GraphSection() {
  const { t, locale } = useLocale();
  const s = settingsText(locale);
  const m = metersText(locale);
  const [settings, setSettings] = useState<GraphSettings>({ ...DEFAULT_GRAPH_SETTINGS });
  // Fase 21: server-side switch (agent settings), null until loaded.
  const [extractionEnabled, setExtractionEnabled] = useState<boolean | null>(null);
  const [extractionBusy, setExtractionBusy] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    try {
      setSettings(parseGraphSettings(window.localStorage.getItem(GRAPH_SETTINGS_KEY)));
    } catch {
      // Storage unavailable: defaults.
    }
    getAgentSettings()
      .then((a) => setExtractionEnabled(a.extraction_enabled))
      .catch(() => setExtractionEnabled(null));
  }, []);

  const toggleExtraction = async (on: boolean) => {
    setExtractionBusy(true);
    setStatus(null);
    try {
      const next = await putAgentSettings({ extraction_enabled: on });
      setExtractionEnabled(next.extraction_enabled);
      setStatus({ type: "success", text: m.extractionSaved });
    } catch (err) {
      setStatus({ type: "error", text: err instanceof Error && err.message ? err.message : m.extractionFailed });
    } finally {
      setExtractionBusy(false);
    }
  };

  const update = (next: GraphSettings) => {
    setSettings(next);
    try {
      window.localStorage.setItem(GRAPH_SETTINGS_KEY, serializeGraphSettings(next));
    } catch {
      // Storage unavailable: keep the in-memory value only.
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader title={s.graphHeading} hint={s.graphHint} />
      <Card>
        <ul className="divide-y divide-border">
          <li className="flex items-center justify-between gap-4 pb-2.5">
            <div className="min-w-0">
              <div className="font-ui text-xs text-foreground">{m.extractionSwitch}</div>
              <div className="text-xs text-muted-foreground">{m.extractionSwitchHint}</div>
            </div>
            <Switch
              checked={extractionEnabled ?? true}
              label={m.extractionSwitch}
              disabled={extractionEnabled === null || extractionBusy}
              onChange={(on) => void toggleExtraction(on)}
            />
          </li>
          <li className="flex items-center justify-between gap-4 pt-2.5">
            <div className="min-w-0">
              <div className="font-ui text-xs text-foreground">{m.renderingSwitch}</div>
              <div className="text-xs text-muted-foreground">{m.renderingSwitchHint}</div>
            </div>
            <Switch
              checked={settings.rendering >= 1}
              label={m.renderingSwitch}
              onChange={(on) => update(withSetting(settings, "rendering", on ? 1 : 0))}
            />
          </li>
        </ul>
        <InlineStatus status={status} />
      </Card>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {GRAPH_SETTING_GROUPS.map((group) => (
          <Card key={group}>
            <h3 className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{t.gsGroups[group]}</h3>
            <div className="flex flex-col gap-3 font-ui text-[11px] text-muted-foreground">
              {graphSettingKeys(group).map((key) => (
                <GraphSettingControl key={key} settingKey={key} settings={settings} onChange={update} idPrefix="settings-graph" />
              ))}
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
