"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Keyboard, X } from "lucide-react";
import { comboFor, formatCombo, SHORTCUTS, type ShortcutScope } from "@/lib/keyboard";
import { dispatchCommand, OPEN_MODEL_PICKER_EVENT /* , TOGGLE_DICTATION_EVENT */ } from "@/lib/command-events";
import { settingsText } from "@/lib/settings-i18n";
import { useLocale } from "./locale-provider";
import { useShortcut } from "./use-shortcut";
import { useKeymap } from "./use-combo-label";

const SCOPES: ShortcutScope[] = ["global", "home", "session"];

/** Cheat sheet of every registered shortcut with its effective combo. */
function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const { locale } = useLocale();
  const s = settingsText(locale);
  const router = useRouter();
  const keymap = useKeymap();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    // Capture phase: Esc closes the sheet without reaching session shortcuts (abort).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[90] bg-background/80 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={s.helpTitle}
        className="w-full max-w-lg max-h-[80vh] overflow-y-auto bg-card border border-border rounded-lg shadow-2xl p-5 font-ui text-[12.5px]"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-title text-lg text-foreground flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-muted-foreground" />
            {s.helpTitle}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
            title={s.close}
            aria-label={s.close}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {SCOPES.map((scope) => (
          <section key={scope} className="mb-4">
            <h3 className="uppercase tracking-wider text-[11px] text-muted-foreground mb-2">{s.scopes[scope]}</h3>
            <dl className="flex flex-col gap-1.5">
              {SHORTCUTS.filter((def) => def.scope === scope).map((def) => (
                <div key={def.id} className="flex items-center justify-between gap-4">
                  <dt className="text-foreground">{s.shortcuts[def.id]}</dt>
                  <dd>
                    <kbd className="px-1.5 py-0.5 rounded border border-border bg-background text-foreground text-[11px]">
                      {keymap ? formatCombo(comboFor(def.id, keymap.overrides), keymap.isMac) : def.combo}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <div className="flex items-center justify-between pt-3 border-t border-border text-[11px] text-muted-foreground">
          <span>{s.helpHint}</span>
          <button
            type="button"
            onClick={() => {
              onClose();
              router.push("/settings#keyboard");
            }}
            className="px-2 py-1 rounded border border-border bg-accent hover:bg-border text-foreground cursor-pointer"
          >
            {s.helpOpenSettings}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * App-wide shortcuts: `?` cheat sheet, ⌘, settings, ⌘K model picker and ⌘D dictation
 * (the last two are window CustomEvents the owning components listen to).
 */
export function GlobalShortcuts() {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);

  useShortcut("help", () => setHelpOpen((open) => !open));
  useShortcut("settings", () => router.push("/settings"));
  useShortcut("modelPicker", () => dispatchCommand(OPEN_MODEL_PICKER_EVENT));
  // Ditado desativado por enquanto: no desktop (Electron) a Web Speech não funciona.
  // useShortcut("dictate", () => dispatchCommand(TOGGLE_DICTATION_EVENT));

  const closeHelp = useCallback(() => setHelpOpen(false), []);

  return helpOpen ? <ShortcutHelp onClose={closeHelp} /> : null;
}
