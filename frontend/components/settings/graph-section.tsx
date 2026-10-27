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
  type GraphSettings,
} from "@/lib/graph-settings";
import { settingsText } from "@/lib/settings-i18n";
import { useLocale } from "@/components/locale-provider";
import { GraphSettingControl, graphSettingKeys } from "@/components/graph-settings-panel";
import { buttonClass, Card, SectionHeader } from "./ui";

/** Settings → Grafo: the ⚙ panel's settings, same localStorage key as the Home. */
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

  return (
    <div className="space-y-6">
      <SectionHeader title={s.graphHeading} hint={s.graphHint} />
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
