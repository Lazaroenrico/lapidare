"use client";

/**
 * Configurações → Trilha: vincula um repositório GitHub como currículo.
 * Valida via `POST /api/import/github/preview` e confirma com
 * `POST /api/import/github/import` (`paths: []`, `use_as_track: true`).
 */

import React, { useEffect, useRef, useState } from "react";
import { GitBranch } from "lucide-react";
import { ApiError, importGithubRepo, isAbortError, previewGithubRepo } from "@/lib/api";
import { isGithubRepoUrl } from "@/lib/import-wire";
import type { GithubImportResult, GithubPreview } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { Badge, Banner, Btn, BusyStrip, Field, errMsg, inputClass } from "./import-ui";

export function GithubTrackLinker({ onLinked }: { onLinked?: (result: GithubImportResult) => void }) {
  const { t } = useLocale();
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<"idle" | "previewing" | "linking">("idle");
  const [preview, setPreview] = useState<GithubPreview | null>(null);
  const [validatedUrl, setValidatedUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [linked, setLinked] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = (next: "previewing" | "linking") => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase(next);
    setError(null);
    return ctrl;
  };
  const finish = (ctrl: AbortController) => {
    if (abortRef.current === ctrl) {
      abortRef.current = null;
      setPhase("idle");
    }
  };
  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
  };

  const validate = async () => {
    if (!isGithubRepoUrl(url)) {
      setError(t.ghInvalid);
      return;
    }
    const ctrl = start("previewing");
    setPreview(null);
    setLinked(false);
    setConflict(false);
    try {
      setPreview(await previewGithubRepo(url, ctrl.signal));
      setValidatedUrl(url.trim());
    } catch (err) {
      if (!isAbortError(err)) setError(errMsg(err, t.ghInvalid));
    } finally {
      finish(ctrl);
    }
  };

  const link = async (replaceTrack = false) => {
    const ctrl = start("linking");
    setConflict(false);
    try {
      const res = await importGithubRepo(
        { url: validatedUrl, paths: [], start_session: false, use_as_track: true, replace_track: replaceTrack },
        ctrl.signal
      );
      setLinked(true);
      onLinked?.(res);
    } catch (err) {
      if (isAbortError(err)) return;
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      else setError(errMsg(err, t.trackLink));
    } finally {
      finish(ctrl);
    }
  };

  const busy = phase !== "idle";

  return (
    <div className="space-y-2 font-ui">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label={t.trackGithub} htmlFor="track-gh-url" hint={t.trackGithubHint}>
            <input
              id="track-gh-url"
              type="url"
              value={url}
              disabled={busy}
              onChange={(e) => {
                setUrl(e.target.value);
                setPreview(null);
                setLinked(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void validate();
                }
              }}
              placeholder={t.ghUrlHint}
              className={inputClass}
            />
          </Field>
        </div>
        <Btn onClick={validate} disabled={busy || !url.trim()} className="mb-5">
          {t.trackValidate}
        </Btn>
      </div>

      {phase === "previewing" && <BusyStrip label={t.ghCloning} onCancel={cancel} cancelLabel={t.impCancel} />}
      {phase === "linking" && <BusyStrip label={t.ghImportingLong} onCancel={cancel} cancelLabel={t.impCancel} />}
      {error && <Banner tone="error">{error}</Banner>}

      {preview && !linked && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent bg-background px-3 py-2 text-[11px] text-muted-foreground">
          <GitBranch className="w-3 h-3" aria-hidden />
          <span className="text-[12.5px] text-foreground">
            {preview.repo.owner}/{preview.repo.name}
          </span>
          <span>@{preview.repo.ref}</span>
          {preview.repo.commit && <Badge>{preview.repo.commit.slice(0, 7)}</Badge>}
          <span>· {t.ghFiles(preview.files.length)}</span>
          {preview.truncated && <Badge tone="warn">2000+</Badge>}
          <Btn variant="primary" className="ml-auto" disabled={busy} onClick={() => link(false)}>
            {t.trackLink}
          </Btn>
        </div>
      )}

      {conflict && (
        <Banner
          tone="warn"
          action={
            <>
              <Btn variant="ghost" onClick={() => setConflict(false)}>
                {t.impCancel}
              </Btn>
              <Btn onClick={() => link(true)}>{t.ghReplaceTrack}</Btn>
            </>
          }
        >
          {t.ghTrackExists}
        </Banner>
      )}

      {linked && <Banner tone="ok">{t.trackLinked}</Banner>}
    </div>
  );
}
