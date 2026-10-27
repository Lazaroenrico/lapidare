"use client";

/**
 * Fase 16 — "Adicionar ao grafo": notas do Vault (árvore por pasta + busca) ou arquivos
 * locais (vão para Fontes/Notas/) viram um job `notes_import`. O resultado por arquivo
 * acompanha o job pelo SSE único (jobs:updated → GET /api/jobs), sem polling.
 * As notas nunca são alteradas; "Tirar do grafo" só desvincula a fonte.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Network, Search, Trash2, Upload, X } from "lucide-react";
import {
  deleteGraphSource,
  getBackgroundJobs,
  importVaultNotesToGraph,
  listGraphSources,
  listImportableNotes,
  uploadNotesToGraph,
} from "@/lib/api";
import {
  NOTE_UPLOAD_EXTENSIONS,
  buildNoteTree,
  decodeJobFiles,
  folderState,
  hasNoteUploadExtension,
  isFinalStatus,
  mergeJobFiles,
  notesText,
  type DeleteSourceMode,
  type GraphSource,
  type ImportableNotes,
  type NotesFileResult,
  type NotesFileStatus,
} from "@/lib/notes-import";
import type { SseEventType } from "@/lib/types";
import { useLocale } from "./locale-provider";
import { useEventSubscription } from "./server-events";
import { Badge, Banner, Btn, FolderCheckbox, cx, errMsg, handleListKeys, inputClass } from "./import-ui";

type Mode = "vault" | "files";

const JOB_EVENTS: SseEventType[] = ["jobs:updated"];
const VAULT_EVENTS: SseEventType[] = ["vault:changed", "graph:updated"];

const STATUS_TONE: Record<NotesFileStatus, string> = {
  queued: "text-muted-foreground border-border",
  running: "text-warning border-warning/40 animate-pulse",
  completed: "text-success border-success/40",
  partial: "text-warning border-warning/40",
  failed: "text-danger border-danger/40",
  rejected: "text-danger border-danger/40",
};

export function NotesGraphPanel() {
  const { locale } = useLocale();
  const nt = notesText(locale);
  const [mode, setMode] = useState<Mode>("vault");
  const [listing, setListing] = useState<ImportableNotes | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<File[]>([]);
  const [badFiles, setBadFiles] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [results, setResults] = useState<NotesFileResult[]>([]);
  const [sources, setSources] = useState<GraphSource[]>([]);
  const [removing, setRemoving] = useState<GraphSource | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refreshNotes = useCallback(() => {
    listImportableNotes()
      .then((l) => {
        setListing(l);
        setListError(null);
      })
      .catch((err) => setListError(errMsg(err, nt.loading)));
    listGraphSources().then(setSources).catch(() => undefined);
  }, [nt.loading]);

  useEffect(() => {
    refreshNotes();
  }, [refreshNotes]);

  // notify → fetch: notas novas no Vault e fontes que mudaram no grafo.
  useEventSubscription(VAULT_EVENTS, () => refreshNotes());

  // Status por arquivo do job corrente (jobs:updated → GET /api/jobs).
  const refreshJob = useCallback(async () => {
    if (!jobId) return;
    try {
      const job = (await getBackgroundJobs()).find((j) => j.job_id === jobId);
      if (job) setResults((prev) => mergeJobFiles(prev, decodeJobFiles(job)));
    } catch {
      /* the tray shows job errors; the panel keeps the last known state */
    }
  }, [jobId]);
  useEventSubscription(JOB_EVENTS, () => void refreshJob());
  useEffect(() => {
    void refreshJob();
  }, [refreshJob]);

  const tree = useMemo(() => buildNoteTree(listing?.notes ?? [], query), [listing, query]);
  const filtering = query.trim().length > 0;

  const setMany = (paths: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });

  const toggleCollapsed = (folder: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  const addFiles = (list: FileList | null | undefined) => {
    if (!list) return;
    const all = Array.from(list);
    const ok = all.filter((f) => hasNoteUploadExtension(f.name));
    setBadFiles(all.filter((f) => !hasNoteUploadExtension(f.name)).map((f) => f.name));
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      return [...prev, ...ok.filter((f) => !names.has(f.name))];
    });
  };

  const count = mode === "vault" ? selected.size : files.length;

  const submit = async () => {
    if (count === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = mode === "vault" ? await importVaultNotesToGraph(Array.from(selected)) : await uploadNotesToGraph(files);
      setResults(res.files);
      setJobId(res.job_id);
      if (mode === "vault") setSelected(new Set());
      else setFiles([]);
    } catch (err) {
      setError(errMsg(err, nt.submitting));
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async (source: GraphSource, removeMode: DeleteSourceMode) => {
    setRemoveBusy(true);
    try {
      await deleteGraphSource(source.id, removeMode);
      setRemoving(null);
      refreshNotes();
    } catch (err) {
      setError(errMsg(err, nt.removeSource));
    } finally {
      setRemoveBusy(false);
    }
  };

  const running = results.some((r) => !isFinalStatus(r.status));

  return (
    <div className="space-y-3">
      <p className="font-ui text-[11px] text-muted-foreground">{nt.intro}</p>

      <div role="radiogroup" aria-label={nt.tab} className="inline-flex rounded-md border border-border p-0.5 bg-background">
        {(["vault", "files"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={cx(
              "px-3 py-0.5 rounded font-ui text-[11px] cursor-pointer transition-colors",
              mode === m ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground focus-visible:text-foreground"
            )}
          >
            {m === "vault" ? nt.modeVault : nt.modeFiles}
          </button>
        ))}
      </div>

      {mode === "vault" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-3 h-3 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <label htmlFor="notes-filter" className="sr-only">
                {nt.searchLabel}
              </label>
              <input
                id="notes-filter"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={nt.searchPlaceholder}
                className={cx(inputClass, "pl-8")}
              />
            </div>
            <span className="font-ui text-[11px] text-muted-foreground shrink-0">{nt.selected(selected.size)}</span>
            <Btn variant="ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
              {nt.clear}
            </Btn>
          </div>

          {listError && <Banner tone="error">{listError}</Banner>}
          {listing?.truncated && <Banner tone="warn">{nt.truncated}</Banner>}
          {listing === null && !listError && <p className="font-ui text-[11px] text-muted-foreground">{nt.loading}</p>}
          {listing && listing.notes.length === 0 && <Banner tone="info">{nt.empty}</Banner>}

          {listing && listing.notes.length > 0 && (
            <div
              role="tree"
              aria-label={nt.modeVault}
              aria-multiselectable="true"
              onKeyDown={handleListKeys}
              className="max-h-64 overflow-y-auto rounded-md border border-accent"
            >
              {tree.length === 0 && <p className="p-3 font-ui text-[11px] text-muted-foreground">{nt.noMatch}</p>}
              {tree.map((group) => {
                const state = folderState(group, selected);
                const open = filtering || !collapsed.has(group.folder);
                const label = group.folder || nt.root;
                const done = group.notes.filter((n) => selected.has(n.path)).length;
                return (
                  <div key={group.folder || "/"} role="treeitem" aria-expanded={open} aria-selected={state === "all"}>
                    <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1 bg-card border-b border-accent">
                      <FolderCheckbox
                        id={`notes-dir-${group.folder || "root"}`}
                        state={state}
                        label={`${nt.selectFolder}: ${label}`}
                        onChange={(on) => setMany(group.notes.map((n) => n.path), on)}
                      />
                      <button
                        type="button"
                        data-nav
                        aria-label={`${nt.toggleFolder}: ${label}`}
                        aria-expanded={open}
                        onClick={() => toggleCollapsed(group.folder)}
                        className="flex-1 flex items-center gap-1 text-left font-ui text-[12.5px] text-foreground cursor-pointer min-w-0"
                      >
                        {open ? (
                          <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" aria-hidden />
                        ) : (
                          <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <span className="truncate">{group.folder ? `${group.folder}/` : nt.root}</span>
                        <span className="ml-auto pl-2 text-[11px] text-muted-foreground shrink-0">
                          {done}/{group.notes.length}
                        </span>
                      </button>
                    </div>
                    {open && (
                      <div role="group">
                        {group.notes.map((n) => {
                          const on = selected.has(n.path);
                          const fid = `notes-file-${n.path}`;
                          return (
                            <label
                              key={n.path}
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
                                onChange={(e) => setMany([n.path], e.target.checked)}
                                className="accent-foreground cursor-pointer"
                              />
                              <FileText className="w-3 h-3 shrink-0 text-muted-foreground" aria-hidden />
                              <span className="min-w-0 flex-1 truncate font-ui text-[12.5px] text-foreground" title={n.path}>
                                {n.name}
                              </span>
                              {n.imported && <Badge>{nt.imported}</Badge>}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div
            role="button"
            tabIndex={0}
            aria-label={nt.drop}
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
              addFiles(e.dataTransfer.files);
            }}
            className={cx(
              "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-6 cursor-pointer transition-colors text-center",
              dragging ? "border-foreground bg-accent" : "border-border bg-background hover:border-muted-foreground focus-visible:border-foreground"
            )}
          >
            <Upload className="w-5 h-5 text-muted-foreground" aria-hidden />
            <span className="font-ui text-[12.5px] text-foreground">{nt.drop}</span>
            <span className="font-ui text-[11px] text-muted-foreground">{nt.accept}</span>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={NOTE_UPLOAD_EXTENSIONS.join(",")}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
              className="hidden"
              tabIndex={-1}
            />
          </div>
          {badFiles.map((name) => (
            <Banner key={name} tone="error">
              {nt.badExt(name)}
            </Banner>
          ))}
          {files.length > 0 && (
            <ul className="rounded-md border border-accent divide-y divide-accent">
              {files.map((f) => (
                <li key={f.name} className="flex items-center gap-2 px-3 py-1 font-ui text-[12.5px] text-foreground">
                  <FileText className="w-3 h-3 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate flex-1">{f.name}</span>
                  <span className="text-[11px] text-muted-foreground shrink-0">{(f.size / 1024).toFixed(1)} KB</span>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}
                    aria-label={`${nt.remove}: ${f.name}`}
                    className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:text-foreground focus-visible:bg-accent cursor-pointer"
                  >
                    <X className="w-3 h-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <Banner tone="error">{error}</Banner>}

      <div className="flex justify-end">
        <Btn variant="primary" disabled={count === 0} busy={busy} onClick={() => void submit()}>
          <Network className="w-3 h-3" aria-hidden />
          {busy ? nt.submitting : nt.submit(count)}
        </Btn>
      </div>

      {results.length > 0 && (
        <section aria-live="polite" aria-busy={running} className="space-y-1">
          <h3 className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{nt.results}</h3>
          <ul className="rounded-md border border-accent divide-y divide-accent">
            {results.map((r) => (
              <li key={`${r.filename}-${r.source_id ?? ""}`} className="px-3 py-1.5 font-ui text-[12.5px]">
                <div className="flex items-center gap-2">
                  <span className="truncate flex-1 text-foreground" title={r.path ?? r.filename}>
                    {r.title || r.filename}
                  </span>
                  {r.new_nodes > 0 && <span className="text-[11px] text-muted-foreground shrink-0">{nt.newNodes(r.new_nodes)}</span>}
                  <span className={cx("text-[11px] px-1.5 rounded border shrink-0", STATUS_TONE[r.status])}>{nt.status(r.status)}</span>
                </div>
                {r.error && (r.status === "failed" || r.status === "partial" || r.status === "rejected") && (
                  <p className="text-[11px] text-danger break-words">{r.error}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-1 pt-2 border-t border-accent">
        <h3 className="font-ui text-[11px] uppercase tracking-wider text-muted-foreground">{nt.sourcesTitle}</h3>
        {sources.length === 0 ? (
          <p className="font-ui text-[11px] text-muted-foreground">{nt.sourcesEmpty}</p>
        ) : (
          <ul className="rounded-md border border-accent divide-y divide-accent">
            {sources.map((s) => (
              <li key={s.id} className="px-3 py-1.5 font-ui text-[12.5px]">
                <div className="flex items-center gap-2">
                  <span className="truncate flex-1 text-foreground" title={s.path}>
                    {s.title}
                  </span>
                  <span className="text-[11px] text-muted-foreground shrink-0">{nt.nodeCount(s.node_count)}</span>
                  <button
                    type="button"
                    onClick={() => setRemoving(removing?.id === s.id ? null : s)}
                    aria-expanded={removing?.id === s.id}
                    title={nt.removeSource}
                    aria-label={`${nt.removeSource}: ${s.title}`}
                    className="p-0.5 rounded text-muted-foreground hover:text-danger hover:bg-accent focus-visible:text-danger focus-visible:bg-accent cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" aria-hidden />
                  </button>
                </div>
                {removing?.id === s.id && (
                  <div className="mt-1.5 space-y-1.5">
                    <p className="text-[11px] text-muted-foreground">{nt.removeHint}</p>
                    <div className="flex flex-wrap gap-2">
                      <Btn variant="secondary" busy={removeBusy} onClick={() => void confirmRemove(s, "preserve-graph")}>
                        {nt.removeKeep}
                      </Btn>
                      <Btn variant="danger" busy={removeBusy} onClick={() => void confirmRemove(s, "delete-nodes")}>
                        {nt.removeNodes}
                      </Btn>
                      <Btn variant="ghost" onClick={() => setRemoving(null)}>
                        {nt.cancel}
                      </Btn>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
