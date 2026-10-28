"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { useEventSubscription } from "@/components/server-events";
import { Btn, inputClass } from "@/components/import-ui";
import { ApiError, getDictationSettings, saveDictationSettings, testDictation } from "@/lib/api";
import { DICTATION_LANGUAGES, errorMessage, type DictationSettings } from "@/lib/dictation-core";
import { dictationText } from "@/lib/dictation-i18n";
import { InlineStatus, SectionHeader } from "./ui";

type Busy = "save" | "remove" | "test" | "language" | null;

/** Settings → Conectores: Deepgram key (never echoed back), language and a connection test. */
export function DictationSection() {
  const { locale } = useLocale();
  const t = dictationText(locale);
  const [settings, setSettings] = useState<DictationSettings>({ configured: false, language: "multi" });
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSettings(await getDictationSettings());
    } catch {
      /* the section stays on its last known state */
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEventSubscription(["config:updated"], () => void refresh());

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<string | void>) => {
    setBusy(kind);
    setStatus(null);
    try {
      const text = await action();
      if (text) setStatus({ type: "success", text });
    } catch (err) {
      setStatus({ type: "error", text: errorMessage(err instanceof ApiError ? err.status : 502, locale) });
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      setSettings(await saveDictationSettings({ api_key: key.trim() }));
      setKey("");
      return t.saved;
    });
  const remove = () =>
    run("remove", async () => {
      setSettings(await saveDictationSettings({ api_key: null }));
      return t.removed;
    });
  const test = () =>
    run("test", async () => {
      await testDictation();
      return t.testOk;
    });
  const changeLanguage = (language: string) =>
    run("language", async () => {
      setSettings(await saveDictationSettings({ language }));
    });

  return (
    <div className="space-y-3">
      <SectionHeader title={t.sectionTitle} hint={t.sectionHint} />
      <div className="p-4 bg-card border border-border rounded space-y-3">
        <div className="space-y-1">
          <label htmlFor="dictation-key" className="flex items-center gap-2 font-ui text-[11px] text-muted-foreground">
            {t.keyLabel}
            <span className={settings.configured ? "text-success" : "text-muted-foreground"}>
              {settings.configured ? t.keyConfigured : t.keyMissing}
            </span>
          </label>
          <input
            id="dictation-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t.keyPlaceholder}
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="dictation-language" className="block font-ui text-[11px] text-muted-foreground">
            {t.languageLabel}
          </label>
          <select
            id="dictation-language"
            value={settings.language}
            disabled={busy !== null}
            onChange={(e) => void changeLanguage(e.target.value)}
            className={inputClass}
          >
            {DICTATION_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {t.languages[lang] ?? lang}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Btn variant="primary" onClick={() => void save()} disabled={!key.trim() || busy !== null} busy={busy === "save"}>
            {t.save}
          </Btn>
          <Btn onClick={() => void remove()} disabled={!settings.configured || busy !== null} busy={busy === "remove"}>
            {t.remove}
          </Btn>
          <Btn onClick={() => void test()} disabled={!settings.configured || busy !== null} busy={busy === "test"}>
            {t.test}
          </Btn>
          {busy === "language" && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" aria-hidden />}
          <InlineStatus status={status} />
        </div>
      </div>
    </div>
  );
}
