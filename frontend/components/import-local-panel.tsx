"use client";

/**
 * Import local: arquivo (.md/.markdown/.txt/.pdf, multipart em /api/import/local)
 * ou texto colado (caminho legado /api/import/ingest).
 */

import React, { useRef, useState } from "react";
import { FileText, Upload } from "lucide-react";
import { createChat, importLocalFile, importSource } from "@/lib/api";
import { LOCAL_IMPORT_EXTENSIONS, hasLocalImportExtension } from "@/lib/import-wire";
import type { ImportResult } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { Banner, Btn, Check, Field, cx, errMsg, inputClass } from "./import-ui";

type Mode = "file" | "paste";

export function LocalImportPanel({ onImported }: { onImported: (result: ImportResult) => void }) {
  const { t } = useLocale();
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [startSession, setStartSession] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (f: File | undefined | null) => {
    setError(null);
    setDone(null);
    if (!f) return;
    if (!hasLocalImportExtension(f.name)) {
      setFile(null);
      setError(t.locBadExt);
      return;
    }
    setFile(f);
  };

  const submitFile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importLocalFile(file, title, startSession);
      setDone(result.imported.length);
      onImported(result);
    } catch (err) {
      setError(errMsg(err, t.impImporting));
    } finally {
      setBusy(false);
    }
  };

  // Caminho legado de texto colado: mantém o comportamento anterior (sempre abre TEACH).
  const submitPaste = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await importSource({
        title: title.trim(),
        file_content: content,
        file_name: `${title.trim().replace(/[^a-zA-Z0-9_-]/g, "_")}.md`,
      });
      let sessionId = res.session_id ?? null;
      if (!sessionId && startSession) {
        const session = await createChat({ mode: "TEACH", topic: title.trim(), source_file: res.source_path });
        sessionId = session.id;
      }
      onImported({
        imported: [{ source_path: res.source_path, paragraph_count: 0, title: title.trim() }],
        session_id: sessionId,
      });
      setDone(1);
    } catch (err) {
      setError(errMsg(err, t.impImporting));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={t.impSources} className="inline-flex rounded-md border border-border p-0.5 bg-background">
        {(["file", "paste"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => {
              setMode(m);
              setError(null);
              setDone(null);
            }}
            className={cx(
              "px-3 py-0.5 rounded font-ui text-[11px] cursor-pointer transition-colors",
              mode === m ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground focus-visible:text-foreground"
            )}
          >
            {m === "file" ? t.locModeFile : t.locModePaste}
          </button>
        ))}
      </div>

      <p className="font-ui text-[11px] text-muted-foreground">{t.locReadonly}</p>

      {mode === "file" ? (
        <form onSubmit={submitFile} className="space-y-3">
          <div
            role="button"
            tabIndex={0}
            aria-label={t.locDrop}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pick(e.dataTransfer.files?.[0]);
            }}
            className={cx(
              "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 cursor-pointer transition-colors text-center",
              dragging
                ? "border-foreground bg-accent"
                : "border-border bg-background hover:border-muted-foreground focus-visible:border-foreground"
            )}
          >
            {file ? (
              <>
                <FileText className="w-5 h-5 text-foreground" aria-hidden />
                <span className="font-ui text-[12.5px] text-foreground">{file.name}</span>
                <span className="font-ui text-[11px] text-muted-foreground">
                  {(file.size / 1024).toFixed(1)} KB · {t.locChangeFile}
                </span>
              </>
            ) : (
              <>
                <Upload className="w-5 h-5 text-muted-foreground" aria-hidden />
                <span className="font-ui text-[12.5px] text-foreground">{t.locDrop}</span>
                <span className="font-ui text-[11px] text-muted-foreground">{t.locAccept}</span>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept={LOCAL_IMPORT_EXTENSIONS.join(",")}
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = "";
              }}
              className="hidden"
              tabIndex={-1}
            />
          </div>

          <Field label={t.locTitleOptional} htmlFor="loc-title">
            <input
              id="loc-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={file ? file.name.replace(/\.[^/.]+$/, "") : t.locTitlePh}
              className={inputClass}
            />
          </Field>

          {error && <Banner tone="error">{error}</Banner>}
          {done !== null && <Banner tone="ok">{t.impImported(done)}</Banner>}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Check id="loc-start-session" checked={startSession} onChange={setStartSession} label={t.impStartSession} />
            <Btn type="submit" variant="primary" disabled={!file} busy={busy}>
              {busy ? t.impImporting : t.impImport}
            </Btn>
          </div>
        </form>
      ) : (
        <form onSubmit={submitPaste} className="space-y-3">
          <Field label={t.locTitle} htmlFor="loc-paste-title">
            <input
              id="loc-paste-title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t.locTitlePh}
              className={inputClass}
            />
          </Field>
          <Field label={t.locContent} htmlFor="loc-paste-content">
            <textarea
              id="loc-paste-content"
              required
              rows={8}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t.locContentPh}
              className="w-full bg-background border border-border focus:border-muted-foreground rounded-md px-3 py-2 font-prose text-base leading-6 text-foreground placeholder-muted-foreground resize-none"
            />
          </Field>

          {error && <Banner tone="error">{error}</Banner>}
          {done !== null && <Banner tone="ok">{t.impImported(done)}</Banner>}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Check id="loc-paste-session" checked={startSession} onChange={setStartSession} label={t.impStartSession} />
            <Btn type="submit" variant="primary" disabled={!title.trim() || !content.trim()} busy={busy}>
              {busy ? t.impImporting : t.impImport}
            </Btn>
          </div>
        </form>
      )}
    </div>
  );
}
