"use client";

/**
 * Import de repositório GitHub: URL → pré-visualização (clone raso no backend) →
 * árvore de arquivos agrupada por pasta → import dos selecionados e/ou uso como Trilha.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, GitBranch, Search } from "lucide-react";
import { ApiError, importGithubRepo, isAbortError, previewGithubRepo } from "@/lib/api";
import { isGithubRepoUrl } from "@/lib/import-wire";
import type { GithubImportResult, GithubPreview, GithubPreviewFile } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { Badge, Banner, Btn, BusyStrip, Check, Field, cx, errMsg, handleListKeys, inputClass } from "./import-ui";

type Phase = "idle" | "previewing" | "importing";

const dirOf = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
};
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

function FolderCheckbox({
  id,
  state,
  onChange,
  label,
}: {
  id: string;
  state: "all" | "some" | "none";
  onChange: (value: boolean) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      id={id}
      data-nav
      type="checkbox"
      aria-label={label}
      checked={state === "all"}
      onChange={(e) => onChange(e.target.checked)}
      className="accent-foreground cursor-pointer"
    />
  );
}

export function GithubImportPanel({ onImported }: { onImported: (result: GithubImportResult) => void }) {
  const { t } = useLocale();
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<GithubPreview | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [useAsTrack, setUseAsTrack] = useState(false);
  const [startSession, setStartSession] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [result, setResult] = useState<GithubImportResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    setStartSession(selected.size === 1);
  }, [selected.size]);

  const begin = (next: Phase) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase(next);
    setError(null);
    setNotice(null);
    return ctrl;
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
    setNotice(t.impCancelled);
  };

  const runPreview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isGithubRepoUrl(url)) {
      setError(t.ghInvalid);
      return;
    }
    const ctrl = begin("previewing");
    setPreview(null);
    setResult(null);
    setConflict(null);
    try {
      const data = await previewGithubRepo(url, ctrl.signal);
      setPreview(data);
      setPreviewUrl(url.trim());
      setSelected(new Set());
      setFilter("");
      // Muitos arquivos → pastas começam recolhidas.
      setCollapsed(data.files.length > 200 ? new Set(data.files.map((f) => dirOf(f.path))) : new Set());
    } catch (err) {
      if (!isAbortError(err)) setError(errMsg(err, t.ghInvalid));
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setPhase("idle");
      }
    }
  };

  const runImport = async (replaceTrack = false) => {
    if (!preview) return;
    const ctrl = begin("importing");
    setConflict(null);
    setResult(null);
    try {
      const paths = preview.files.filter((f) => selected.has(f.path)).map((f) => f.path);
      const res = await importGithubRepo(
        {
          url: previewUrl,
          paths,
          start_session: startSession && paths.length > 0,
          use_as_track: useAsTrack,
          replace_track: replaceTrack,
        },
        ctrl.signal
      );
      setResult(res);
      onImported(res);
    } catch (err) {
      if (isAbortError(err)) return;
      if (err instanceof ApiError && err.status === 409) setConflict(err.message || t.ghTrackExists);
      else setError(errMsg(err, t.impImporting));
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setPhase("idle");
      }
    }
  };

  const groups = useMemo(() => {
    if (!preview) return [] as Array<[string, GithubPreviewFile[]]>;
    const q = filter.trim().toLowerCase();
    const map = new Map<string, GithubPreviewFile[]>();
    for (const f of preview.files) {
      if (q && !f.path.toLowerCase().includes(q) && !(f.title ?? "").toLowerCase().includes(q)) continue;
      const d = dirOf(f.path);
      const list = map.get(d) ?? [];
      list.push(f);
      map.set(d, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [preview, filter]);

  const setMany = (paths: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });

  const toggleCollapsed = (dir: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const busy = phase !== "idle";
  const filtering = filter.trim().length > 0;

  return (
    <div className="space-y-3">
      <form onSubmit={runPreview} className="flex items-end gap-2">
        <div className="flex-1">
          <Field label={t.ghUrl} htmlFor="gh-url">
            <input
              id="gh-url"
              type="url"
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t.ghUrlHint}
              disabled={busy}
              className={inputClass}
            />
          </Field>
        </div>
        <Btn type="submit" variant={preview ? "secondary" : "primary"} disabled={busy || !url.trim()}>
          {t.ghPreview}
        </Btn>
      </form>

      {phase === "previewing" && <BusyStrip label={t.ghCloning} onCancel={cancel} cancelLabel={t.impCancel} />}
      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="info">{notice}</Banner>}

      {preview && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent bg-background px-3 py-2 font-ui text-[11px] text-muted-foreground">
            <GitBranch className="w-3 h-3" aria-hidden />
            <span className="text-foreground text-[12.5px]">
              {preview.repo.owner}/{preview.repo.name}
            </span>
            <span>@{preview.repo.ref}</span>
            {preview.repo.commit && <Badge>{preview.repo.commit.slice(0, 7)}</Badge>}
            {preview.repo.subpath && <span>· {preview.repo.subpath}</span>}
            <span className="ml-auto">{t.ghFiles(preview.files.length)}</span>
          </div>

          {preview.truncated && <Banner tone="warn">{t.ghTruncated}</Banner>}

          {preview.files.length === 0 ? (
            <Banner tone="info">{t.ghNoFiles}</Banner>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="w-3 h-3 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <label htmlFor="gh-filter" className="sr-only">
                    {t.impFilterLabel}
                  </label>
                  <input
                    id="gh-filter"
                    type="search"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t.impFilter}
                    className={cx(inputClass, "pl-8")}
                  />
                </div>
                <span className="font-ui text-[11px] text-muted-foreground shrink-0">{t.impSelected(selected.size)}</span>
                <Btn variant="ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
                  {t.impClear}
                </Btn>
              </div>

              <div
                role="tree"
                aria-label={`${preview.repo.owner}/${preview.repo.name}`}
                onKeyDown={handleListKeys}
                className="max-h-72 overflow-y-auto rounded-md border border-accent"
              >
                {groups.length === 0 && <p className="p-3 font-ui text-[11px] text-muted-foreground">{t.impNoMatch}</p>}
                {groups.map(([dir, files]) => {
                  const count = files.filter((f) => selected.has(f.path)).length;
                  const state = count === 0 ? "none" : count === files.length ? "all" : "some";
                  const open = filtering || !collapsed.has(dir);
                  const gid = `gh-dir-${dir || "root"}`;
                  return (
                    <div key={dir || "/"} role="treeitem" aria-expanded={open} aria-selected={state === "all"}>
                      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1 bg-card border-b border-accent">
                        <FolderCheckbox
                          id={gid}
                          state={state}
                          label={`${t.ghSelectFolder}: ${dir || t.ghRoot}`}
                          onChange={(on) => setMany(files.map((f) => f.path), on)}
                        />
                        <button
                          type="button"
                          data-nav
                          aria-label={`${t.ghToggleFolder}: ${dir || t.ghRoot}`}
                          aria-expanded={open}
                          onClick={() => toggleCollapsed(dir)}
                          className="flex-1 flex items-center gap-1 text-left font-ui text-[12.5px] text-foreground cursor-pointer min-w-0"
                        >
                          {open ? (
                            <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" aria-hidden />
                          ) : (
                            <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" aria-hidden />
                          )}
                          <span className="truncate">{dir ? `${dir}/` : t.ghRoot}</span>
                          <span className="ml-auto pl-2 text-[11px] text-muted-foreground shrink-0">
                            {count}/{files.length}
                          </span>
                        </button>
                      </div>
                      {open && (
                        <div role="group">
                          {files.map((f) => {
                            const fid = `gh-file-${f.path}`;
                            const on = selected.has(f.path);
                            return (
                              <label
                                key={f.path}
                                htmlFor={fid}
                                role="treeitem"
                                aria-selected={on}
                                className={cx(
                                  "flex items-center gap-2 pl-8 pr-3 py-1 cursor-pointer transition-colors",
                                  on ? "bg-accent" : "hover:bg-background"
                                )}
                              >
                                <input
                                  id={fid}
                                  data-nav
                                  type="checkbox"
                                  checked={on}
                                  onChange={(e) => setMany([f.path], e.target.checked)}
                                  className="accent-foreground cursor-pointer"
                                />
                                <span className="min-w-0 flex-1 truncate font-ui text-[12.5px] text-foreground" title={f.path}>
                                  {baseOf(f.path)}
                                  {f.title && f.title !== baseOf(f.path) && (
                                    <span className="text-muted-foreground"> — {f.title}</span>
                                  )}
                                </span>
                                <span className="font-ui text-[11px] text-muted-foreground shrink-0">{fmtSize(f.size)}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="space-y-2">
            <Check
              id="gh-use-as-track"
              checked={useAsTrack}
              onChange={setUseAsTrack}
              label={t.ghUseAsTrack}
              hint={t.ghUseAsTrackHint}
            />
            <Check
              id="gh-start-session"
              checked={startSession}
              onChange={setStartSession}
              disabled={selected.size === 0}
              label={t.impStartSession}
            />
          </div>

          {conflict && (
            <Banner
              tone="warn"
              action={
                <>
                  <Btn variant="ghost" onClick={() => setConflict(null)}>
                    {t.impCancel}
                  </Btn>
                  <Btn variant="secondary" onClick={() => runImport(true)}>
                    {t.ghReplaceTrack}
                  </Btn>
                </>
              }
            >
              {t.ghTrackExists}
              {conflict !== t.ghTrackExists && <span className="block text-muted-foreground">{conflict}</span>}
            </Banner>
          )}

          {phase === "importing" && <BusyStrip label={t.ghImportingLong} onCancel={cancel} cancelLabel={t.impCancel} />}

          {result && (
            <Banner tone="ok">
              {t.impImported(result.imported.length)}
              {result.track_job_id && <span className="block">{t.ghTrackQueued}</span>}
            </Banner>
          )}

          <div className="flex justify-end">
            <Btn
              variant="primary"
              disabled={busy || (selected.size === 0 && !useAsTrack)}
              onClick={() => runImport(false)}
            >
              {`${t.ghImportSelected} (${selected.size})`}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
