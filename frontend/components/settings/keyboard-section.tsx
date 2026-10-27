"use client";

import React, { useEffect, useState } from "react";
import { AlertTriangle, Keyboard, RotateCcw } from "lucide-react";
import {
  comboFor,
  conflicts,
  formatCombo,
  KEYMAP_CHANGED_EVENT,
  saveKeymap,
  SHORTCUTS,
  type ShortcutId,
} from "@/lib/keyboard";
import { captureCombo } from "@/lib/key-capture";
import { settingsText } from "@/lib/settings-i18n";
import { useLocale } from "@/components/locale-provider";
import { useKeymap } from "@/components/use-combo-label";
import { buttonClass, SectionHeader } from "./ui";

type Keymap = Partial<Record<ShortcutId, string>>;

const defaultCombo = (id: ShortcutId) => SHORTCUTS.find((def) => def.id === id)!.combo;

function persist(map: Keymap) {
  saveKeymap(map);
  window.dispatchEvent(new CustomEvent(KEYMAP_CHANGED_EVENT));
}

/** Settings → Teclado: rebind registry shortcuts (localStorage `learnharness:keymap`). */
export function KeyboardSection() {
  const { locale } = useLocale();
  const s = settingsText(locale);
  const keymap = useKeymap();
  const overrides: Keymap = keymap?.overrides ?? {};
  const isMac = keymap?.isMac ?? false;
  const [capturing, setCapturing] = useState<ShortcutId | null>(null);
  const [invalid, setInvalid] = useState(false);

  const setCombo = (id: ShortcutId, combo: string | null) => {
    const next: Keymap = { ...overrides };
    if (combo === null || combo === defaultCombo(id)) delete next[id];
    else next[id] = combo;
    persist(next);
  };

  useEffect(() => {
    if (!capturing) return;
    // Capture phase on window: the press never reaches useShortcut handlers.
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const result = captureCombo(event, isMac);
      if (result.kind === "pending") return;
      if (result.kind === "cancel") {
        setCapturing(null);
        setInvalid(false);
      } else if (result.kind === "invalid") {
        setInvalid(true);
      } else {
        setCombo(capturing, result.combo);
        setCapturing(null);
        setInvalid(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, isMac, overrides]);

  const clashes = conflicts(overrides);
  const clashing = new Set(clashes.flat());

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <SectionHeader title={s.keyboardHeading} hint={s.keyboardHint} />
        <button
          type="button"
          disabled={Object.keys(overrides).length === 0}
          onClick={() => {
            setCapturing(null);
            persist({});
          }}
          className={`${buttonClass} shrink-0`}
        >
          <RotateCcw className="w-3 h-3" />
          {s.restoreAll}
        </button>
      </div>

      {clashes.map((ids) => (
        <div
          key={ids.join("|")}
          role="alert"
          className="flex items-center gap-2 p-3 rounded border border-warning/40 bg-warning/10 text-warning font-ui text-[11px]"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {s.conflictWarning(ids.map((id) => s.shortcuts[id]).join(", "))}
        </div>
      ))}

      <div className="bg-card border border-border rounded overflow-x-auto">
        <table className="w-full font-ui text-[12px] text-left">
          <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-3 max-sm:px-2 py-2 font-normal">{s.colAction}</th>
              <th className="px-3 max-sm:px-2 py-2 font-normal max-sm:hidden">{s.colScope}</th>
              <th className="px-3 max-sm:px-2 py-2 font-normal">{s.colShortcut}</th>
              <th className="px-3 max-sm:px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((def) => {
              const custom = def.id in overrides;
              const active = capturing === def.id;
              return (
                <tr key={def.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 max-sm:px-2 py-2 text-foreground">{s.shortcuts[def.id]}</td>
                  <td className="px-3 max-sm:px-2 py-2 text-muted-foreground max-sm:hidden">{s.scopes[def.scope]}</td>
                  <td className="px-3 max-sm:px-2 py-2">
                    {active ? (
                      <span aria-live="polite" className={invalid ? "text-danger" : "text-foreground"}>
                        {invalid ? s.captureInvalid : s.capturing}
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <kbd
                          className={`px-1.5 py-0.5 rounded border bg-background text-[11px] whitespace-nowrap ${
                            clashing.has(def.id) ? "border-warning text-warning" : "border-border text-foreground"
                          }`}
                        >
                          {formatCombo(comboFor(def.id, overrides), isMac)}
                        </kbd>
                        {custom && <span className="text-[10px] text-muted-foreground">{s.customized}</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 max-sm:px-2 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setInvalid(false);
                          setCapturing(active ? null : def.id);
                        }}
                        aria-pressed={active}
                        className={buttonClass}
                      >
                        <Keyboard className="w-3 h-3 sm:hidden" aria-hidden />
                        <span className="max-sm:sr-only">{s.rebind}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!custom}
                        onClick={() => setCombo(def.id, null)}
                        className={buttonClass}
                        title={s.restore}
                        aria-label={`${s.restore}: ${s.shortcuts[def.id]}`}
                      >
                        <RotateCcw className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
