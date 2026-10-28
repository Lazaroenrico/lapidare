"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Cpu,
  Download,
  Edit3,
  Pencil,
  Trash2,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Square,
  Search,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import type { BackgroundJobStatus, SessionMode, SessionRecord, SseEventType } from "@/lib/types";
import { partitionTrayJobs } from "@/lib/jobs-tray";
import { decodeJobFiles, notesText } from "@/lib/notes-import";
import { chatMarkdownUrl, createChat, deleteChat, extractSessionToGraph, listChats, renameChat, retryJob, cancelJob } from "@/lib/api";
import {
  filterByMode,
  fuzzyFilter,
  isStreamingTick,
  moveCursor,
  normalizeTitle,
  relativeTime,
  rowStatus,
  TITLE_MAX,
  type RowStatus,
  type SessionFilter,
} from "@/lib/session-ux";
import { comboFor, formatCombo } from "@/lib/keyboard";
import { useEventSubscription, useServerEvents } from "./server-events";
import { useLocale } from "./locale-provider";
import { useShortcut } from "./use-shortcut";
import { ConfirmDialog } from "./session-ux";
import { SessionTrashDialog, useSessionTrash } from "./session-trash";
import { trashText } from "@/lib/session-trash";
import { requestComposerFocus } from "./composer-focus";
import { SettingsComboHint } from "./use-combo-label";
import { useTracks } from "./use-tracks";
import { TrackDot } from "./tracks-ui";
import { useNarrowViewport } from "./nav-drawer";
import { sidebarPresentation, toggleSidebarAction, TOGGLE_NAV_DRAWER_EVENT } from "@/lib/nav-drawer";
import {
  filterByTrack,
  orderTracks,
  parseTrackFilter,
  resolveTrackRef,
  sanitizeTrackFilter,
  shortTrackTag,
  toneForTrack,
  trackFilterFor,
  trackTones,
  TRACK_FILTER_ALL,
  TRACK_FILTER_NONE,
  type TrackFilter,
} from "@/lib/tracks";
import { tracksText } from "@/lib/tracks-i18n";

const COLLAPSED_STORAGE_KEY = "learnharness:sidebar-collapsed";

function loadCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveCollapsed(value: boolean) {
  try {
    globalThis.localStorage?.setItem(COLLAPSED_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Storage unavailable: the toggle still works for this page view.
  }
}

const TRACK_FILTER_STORAGE_KEY = "learnharness:sidebar-track-filter";

function loadTrackFilter(): TrackFilter {
  try {
    return parseTrackFilter(globalThis.localStorage?.getItem(TRACK_FILTER_STORAGE_KEY));
  } catch {
    return TRACK_FILTER_ALL;
  }
}

function saveTrackFilter(value: TrackFilter) {
  try {
    globalThis.localStorage?.setItem(TRACK_FILTER_STORAGE_KEY, value);
  } catch {
    // Storage unavailable: the filter still applies for this page view.
  }
}

const EXTRACT_NOTICE_MS = 6000;
// Rasterized from lapidare_logo.svg (the source SVG is 1.7 MB of embedded bitmaps).
const BRAND_MARK = "/brand/lapidare-mark.png";
const SIDEBAR_EVENTS: SseEventType[] = ["session:updated", "plan:updated", "dock:opened", "dock:resolved"];

type ExtractNotice = { sessionId: string; ok: boolean; text: string };

interface SidebarProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function Sidebar({ collapsed: collapsedProp, onToggleCollapse: onToggleProp }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { activeJobs } = useServerEvents();
  const { locale, t } = useLocale();
  const tt = tracksText(locale);
  const trash = useSessionTrash();
  const [trashOpen, setTrashOpen] = useState(false);
  const { tracks, loaded: tracksLoaded, error: tracksError } = useTracks();
  const trackOptions = useMemo(() => orderTracks(tracks), [tracks]);
  const tones = useMemo(() => trackTones(tracks), [tracks]);
  const [trackFilterRaw, setTrackFilterRaw] = useState<TrackFilter>(TRACK_FILTER_ALL);
  useEffect(() => setTrackFilterRaw(loadTrackFilter()), []);
  // A filter on a removed track falls back to "all" (only once the list is known).
  const trackFilter = tracksLoaded ? sanitizeTrackFilter(trackFilterRaw, tracks) : trackFilterRaw;
  const changeTrackFilter = (value: TrackFilter) => {
    setTrackFilterRaw(value);
    saveTrackFilter(value);
  };

  // Uncontrolled by default (the root layout passes nothing): remembered per browser.
  const [collapsedState, setCollapsedState] = useState(false);
  useEffect(() => setCollapsedState(loadCollapsed()), []);
  const collapsedPref = collapsedProp ?? collapsedState;
  const onToggleCollapse = () => {
    if (onToggleProp) return onToggleProp();
    setCollapsedState((prev) => {
      saveCollapsed(!prev);
      return !prev;
    });
  };

  // Narrow viewports (< md): off-canvas drawer, closed by default, never persisted.
  const narrow = useNarrowViewport();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const view = sidebarPresentation(narrow, collapsedPref, drawerOpen);
  const collapsed = view.variant === "rail";
  const asideRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closeDrawer = () => setDrawerOpen(false);
  useEffect(() => {
    const onToggle = () => {
      setDrawerOpen((open) => {
        if (!open && document.activeElement instanceof HTMLElement) returnFocusRef.current = document.activeElement;
        return !open;
      });
    };
    window.addEventListener(TOGGLE_NAV_DRAWER_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_NAV_DRAWER_EVENT, onToggle);
  }, []);
  // Navigating (a session row, Settings, the logo) or widening the window closes it.
  useEffect(() => setDrawerOpen(false), [pathname, narrow]);
  // Esc closes first (capture phase + preventDefault, so the session's Esc chain does not also run).
  useEffect(() => {
    if (!view.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [view.open]);
  // Focus moves into the drawer when it opens and back to the ☰ button when it closes.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (view.open && !wasOpenRef.current) {
      asideRef.current?.querySelector<HTMLElement>("button, a[href], input")?.focus();
    } else if (!view.open && wasOpenRef.current) {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected && !asideRef.current?.contains(target)) target.focus();
    }
    wasOpenRef.current = view.open;
  }, [view.open]);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<Record<string, string>>({});
  // `activeJobs` holds every known job record: fold by job_id, then split into the
  // queued/running ones and the recent failures (retry lives there).
  const { running: runningJobs, failed: failedJobs } = useMemo(
    () => partitionTrayJobs(activeJobs, Date.now()),
    [activeJobs],
  );
  const [showFailedJobs, setShowFailedJobs] = useState(false);

  // Retry a failed/interrupted job. The backend broadcasts `jobs:updated`,
  // which refreshes `activeJobs` through the shared SSE channel (notify -> fetch).
  const handleRetryJob = async (job: BackgroundJobStatus) => {
    setRetryingJobId(job.job_id);
    setRetryError((prev) => {
      const next = { ...prev };
      delete next[job.job_id];
      return next;
    });
    try {
      await retryJob(job.job_id);
    } catch (err: any) {
      setRetryError((prev) => ({ ...prev, [job.job_id]: err?.message || t.statusFailed }));
    } finally {
      setRetryingJobId(null);
    }
  };

  // Cancel a queued/running job; the backend records it as interrupted and broadcasts `jobs:updated`.
  const handleCancelJob = async (job: BackgroundJobStatus) => {
    setCancellingJobId(job.job_id);
    setRetryError((prev) => {
      const next = { ...prev };
      delete next[job.job_id];
      return next;
    });
    try {
      await cancelJob(job.job_id);
    } catch (err: any) {
      setRetryError((prev) => ({ ...prev, [job.job_id]: err?.message || t.statusFailed }));
    } finally {
      setCancellingJobId(null);
    }
  };

  // One tray card: label, status, activity line, per-file status (notes_import) and error + retry.
  const renderJob = (job: BackgroundJobStatus) => {
    const canRetry = job.status === "failed" || job.status === "interrupted";
    const busy = job.status === "queued" || job.status === "running";
    const err = retryError[job.job_id] || job.error;
    return (
      <div
        key={job.job_id}
        className="p-1.5 bg-card border border-border rounded flex flex-col gap-1 text-[10.5px]"
      >
        <div className="flex items-center justify-between gap-1">
          <span className="font-medium text-foreground truncate" title={job.kind}>
            {job.label || job.kind}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <span
              className={`text-[9px] px-1 py-0.2 rounded border ${
                busy
                  ? "bg-warning/10 text-warning border-warning/30 animate-pulse"
                  : canRetry
                  ? "bg-danger/10 text-danger border-danger/40"
                  : "bg-accent text-muted-foreground border-border"
              }`}
            >
              {t.jobStatus(job.status)}
            </span>
            {busy && (
              <button
                type="button"
                onClick={() => void handleCancelJob(job)}
                disabled={cancellingJobId === job.job_id}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer disabled:cursor-not-allowed transition-colors"
                title={cancellingJobId === job.job_id ? t.cancellingJob : t.cancelJob}
                aria-label={t.cancelJob}
              >
                {cancellingJobId === job.job_id ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Square className="w-3 h-3" />
                )}
              </button>
            )}
            {canRetry && (
              <button
                type="button"
                onClick={() => void handleRetryJob(job)}
                disabled={retryingJobId === job.job_id}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer disabled:cursor-not-allowed transition-colors"
                title={retryingJobId === job.job_id ? t.retrying : t.retry}
                aria-label={t.retry}
              >
                {retryingJobId === job.job_id ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RotateCcw className="w-3 h-3" />
                )}
              </button>
            )}
          </div>
        </div>
        {job.activity && (
        <p className="font-ui text-[11px] text-muted-foreground truncate" title={job.activity}>
          {job.activity}
        </p>
      )}
      {job.kind === "notes_import" && (
          <ul className="flex flex-col gap-0.5 pl-1.5 border-l border-border">
            {decodeJobFiles(job).map((f) => (
              <li key={f.source_id ?? f.filename} className="flex items-center justify-between gap-1 text-[9.5px]">
                <span className="truncate text-muted-foreground" title={f.path ?? f.filename}>
                  {f.title}
                </span>
                <span
                  className={`shrink-0 ${
                    f.status === "failed" ? "text-danger" : f.status === "partial" || f.status === "running" ? "text-warning" : "text-muted-foreground"
                  }`}
                >
                  {notesText(locale).status(f.status)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {err && (canRetry || busy) && (
          <p className="text-[9.5px] text-danger break-words line-clamp-2" title={err}>
            {err}
          </p>
        )}
      </div>
    );
  };

  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [filter, setFilter] = useState<SessionFilter>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [cursor, setCursor] = useState(-1);
  const [searchCombo, setSearchCombo] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [pendingSearchFocus, setPendingSearchFocus] = useState(false);

  // Row rename (inline) and delete dialog.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionRecord | null>(null);
  const [deleteNodes, setDeleteNodes] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showAgentsTray, setShowAgentsTray] = useState<boolean>(false);
  const [creatingMode, setCreatingMode] = useState<SessionMode | null>(null);

  // Per-session context menu ("⋯" button or right click) with "Extrair para o grafo".
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const [extractNotice, setExtractNotice] = useState<ExtractNotice | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuSessionId) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuSessionId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Prevented: the session's Esc chain (useShortcut "abort") skips this keypress.
        e.preventDefault();
        setMenuSessionId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuSessionId]);

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
  }, []);

  const showNotice = (notice: ExtractNotice) => {
    setExtractNotice(notice);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setExtractNotice(null), EXTRACT_NOTICE_MS);
  };

  // POST /api/graph/extract/{id}; the job appears in BACKGROUND AGENTS via `jobs:updated`.
  const handleExtract = async (sessionId: string) => {
    setMenuSessionId(null);
    setExtractingId(sessionId);
    try {
      await extractSessionToGraph(sessionId);
      showNotice({ sessionId, ok: true, text: t.extractQueued });
      setShowAgentsTray(true);
    } catch (err) {
      showNotice({
        sessionId,
        ok: false,
        text: `${t.extractFailed} ${err instanceof Error ? err.message : ""}`.trim(),
      });
    } finally {
      setExtractingId(null);
    }
  };

  const fetchSessionList = async () => {
    try {
      const data = await listChats();
      setSessions(data || []);
    } catch {
      // In early boot, fallback silently
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchSessionList();
  }, []);

  // Subscribe to SSE updates to refresh session list automatically (notify -> fetch)
  useEventSubscription(
    SIDEBAR_EVENTS,
    (event) => {
      // Live-text ticks (every ~0.2 s while a reply streams) change no row.
      if (isStreamingTick(event.data)) return;
      void fetchSessionList();
    }
  );

  const filteredSessions = useMemo(
    () => fuzzyFilter(filterByTrack(filterByMode(sessions, filter), trackFilter), searchQuery, (s) => [s.title, s.topic]),
    [sessions, filter, trackFilter, searchQuery],
  );
  const showTrackFilter = tracks.length > 1;

  useEffect(() => setCursor(-1), [searchQuery, filter, trackFilter]);

  // Global shortcuts (registry ids; rebindable in Settings → Teclado).
  useEffect(() => {
    setSearchCombo(formatCombo(comboFor("sessionSearch"), /Mac|iPhone|iPad/.test(navigator.platform)));
  }, []);
  useShortcut("toggleSidebar", () => {
    if (toggleSidebarAction(narrow) === "drawer") window.dispatchEvent(new CustomEvent(TOGGLE_NAV_DRAWER_EVENT));
    else onToggleCollapse();
  });
  useShortcut("sessionSearch", () => {
    if (view.drawer && !view.open) {
      window.dispatchEvent(new CustomEvent(TOGGLE_NAV_DRAWER_EVENT));
      setPendingSearchFocus(true);
    } else if (collapsed) {
      onToggleCollapse();
      setPendingSearchFocus(true);
    } else {
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  });
  const searchHidden = collapsed || (view.drawer && !view.open);
  useEffect(() => {
    if (!pendingSearchFocus || searchHidden) return;
    searchRef.current?.focus();
    setPendingSearchFocus(false);
  }, [pendingSearchFocus, searchHidden]);
  useShortcut("newSession", () => {
    router.push("/");
    requestComposerFocus();
  });
  useShortcut("goGraph", () => router.push("/"));

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((cur) => moveCursor(cur, filteredSessions.length, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      const target = filteredSessions[cursor >= 0 ? cursor : 0];
      if (!target) return;
      e.preventDefault();
      router.push(`/chat/${target.id}`);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (searchQuery) setSearchQuery("");
      else searchRef.current?.blur();
    }
  };

  const startRename = (session: SessionRecord) => {
    setMenuSessionId(null);
    setRenamingId(session.id);
    setRenameDraft(session.title || session.topic || "");
    setRenameError(null);
  };

  const commitRename = async (session: SessionRecord) => {
    const next = normalizeTitle(renameDraft, session.title || session.topic || "");
    if (!next) {
      setRenamingId(null);
      return;
    }
    try {
      await renameChat(session.id, next);
      setRenamingId(null);
      void fetchSessionList();
    } catch (err) {
      setRenameError(`${t.uxRenameFailed} ${err instanceof Error ? err.message : ""}`.trim());
    }
  };

  const handleExport = (sessionId: string) => {
    setMenuSessionId(null);
    const a = document.createElement("a");
    a.href = chatMarkdownUrl(sessionId);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const openDelete = (session: SessionRecord) => {
    setMenuSessionId(null);
    setDeleteTarget(session);
    setDeleteNodes(false);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteChat(deleteTarget.id, deleteNodes ? "delete-nodes" : "preserve-graph");
      if (pathname === `/chat/${deleteTarget.id}`) router.push("/");
      setDeleteTarget(null);
      void fetchSessionList();
    } catch (err) {
      setDeleteError(`${t.uxDeleteFailed} ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setDeleteBusy(false);
    }
  };

  const statusText = (status: RowStatus, now: number): string => {
    switch (status.kind) {
      case "failed":
        return t.uxRowFailed;
      case "waiting":
        return t.uxRowWaiting;
      case "problem":
        return t.uxRowProblem;
      case "compacting":
        return t.uxRowCompacting;
      case "working":
        return t.uxRowWorking;
      case "idle":
        return relativeTime(status.updatedAt, now, locale);
    }
  };

  const handleStartSession = async (mode: SessionMode) => {
    try {
      setCreatingMode(mode);
      const newSession = await createChat({
        mode,
        topic: mode === "TEACH" ? t.newTeachTopic : t.newPracticeTopic,
      });
      await fetchSessionList();
      router.push(`/chat/${newSession.id}`);
    } catch (err) {
      console.error("Failed to create session:", err);

    } finally {
      setCreatingMode(null);
    }
  };

  const getStatusIndicator = (session: SessionRecord) => {
    const exec = session.execution_status;
    if (session.recovery_required || exec === "failed" || exec === "interrupted") {
      const label = exec === "interrupted" ? t.statusInterrupted : t.statusFailed;
      return (
        <span
          className="inline-block w-2 h-2 rounded-full bg-danger shrink-0"
          title={session.error ? `${label}: ${session.error}` : label}
          aria-label={label}
        />
      );
    }
    if (session.status === "waiting_quiz") {
      return (
        <span
          className="inline-block w-2 h-2 rounded-full bg-warning animate-pulse shrink-0"
          title={t.statusWaiting}
        />
      );
    }
    if (exec === "queued" || exec === "running" || exec === "compacting") {
      return (
        <span
          className="inline-block w-2 h-2 rounded-full bg-muted-foreground animate-ping shrink-0"
          title={t.statusTeaching}
        />
      );
    }
    // Idle / completed rows carry no dot: only "needs you" (amber) and "broken" (red) stand out.
    return null;
  };

  if (collapsed) {
    return (
      <aside className="w-14 bg-background border-r border-border flex flex-col justify-between items-center py-4 select-none shrink-0 transition-all duration-200 z-30 max-md:hidden">
        <div className="flex flex-col items-center gap-4 w-full">
          <Link href="/" title="Lapidare" aria-label="Lapidare" className="rounded cursor-pointer">
            <Image src={BRAND_MARK} alt="" width={28} height={28} priority />
          </Link>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-card rounded cursor-pointer transition-colors"
            title={t.expandSidebar}
            aria-label={t.expandSidebar}
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <div className="w-8 h-px bg-border" />

          <button
            type="button"
            onClick={() => handleStartSession("TEACH")}
            disabled={creatingMode !== null}
            className="p-2 text-foreground hover:bg-accent rounded cursor-pointer transition-colors"
            title={t.newTeachTitle}
            aria-label={t.newTeachTitle}
          >
            <Plus className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => handleStartSession("PRACTICE")}
            disabled={creatingMode !== null}
            className="p-2 text-foreground hover:bg-accent rounded cursor-pointer transition-colors"
            title={t.newPracticeTitle}
            aria-label={t.newPracticeTitle}
          >
            <Sparkles className="w-4 h-4" />
          </button>

          <Link
            href="/draw/new"
            className="p-2 text-foreground hover:bg-accent rounded cursor-pointer transition-colors"
            title={t.newDrawTitle}
            aria-label={t.newDrawTitle}
          >
            <Edit3 className="w-4 h-4" />
          </Link>
        </div>

        <div className="flex flex-col items-center gap-3 w-full">
          {runningJobs.length > 0 && (
            <div
              className="p-2 text-warning animate-pulse"
              title={t.agentsRunning(runningJobs.length)}
            >
              <Cpu className="w-4 h-4" />
            </div>
          )}

          <Link
            href="/settings"
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-card rounded cursor-pointer transition-colors"
            title={t.settingsNav}
            aria-label={t.settingsNav}
          >
            <Settings className="w-4 h-4" />
          </Link>
        </div>
      </aside>
    );
  }

  // Below `md` the CSS alone keeps the panel off-canvas until opened (also on the first,
  // server-rendered paint); no transform while open, so `fixed` dialogs inside stay viewport-fixed.
  const drawerClasses = `max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:max-w-[85vw] ${
    view.open ? "max-md:shadow-2xl" : "max-md:-translate-x-full"
  }`;

  return (
    <>
    {view.open && (
      <div
        aria-hidden
        onClick={closeDrawer}
        className="fixed inset-0 z-40 bg-background/70 backdrop-blur-[2px] md:hidden"
      />
    )}
    <aside
      ref={asideRef}
      id="app-sidebar"
      inert={view.drawer && !view.open}
      role={view.drawer ? "dialog" : undefined}
      aria-modal={view.open ? true : undefined}
      aria-label={view.drawer ? "Lapidare" : undefined}
      className={`w-[260px] bg-background border-r border-border flex flex-col justify-between select-none shrink-0 h-screen h-dvh overflow-hidden text-xs font-ui transition-all duration-200 z-30 ${drawerClasses}`}
    >
      {/* Top: logo + collapse; quiet actions; SESSÕES label with inline search; segmented filter */}
      <div className="px-3 pt-3 pb-2 flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 group cursor-pointer"
          >
            <Image src={BRAND_MARK} alt="" width={22} height={22} priority />
            <span className="font-title text-base font-bold text-foreground tracking-tight group-hover:text-foreground transition-colors">
              Lapidare
            </span>
          </Link>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-card rounded cursor-pointer transition-colors max-md:hidden"
            title={t.collapseSidebar}
            aria-label={t.collapseSidebar}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={closeDrawer}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-card rounded cursor-pointer transition-colors md:hidden"
            title={t.closeNav}
            aria-label={t.closeNav}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Quiet actions: + ENSINAR · PRÁTICA · (desenho as a small icon) */}
        <div className="flex items-center gap-1 -mx-1.5">
          <button
            type="button"
            onClick={() => handleStartSession("TEACH")}
            disabled={creatingMode !== null}
            className="flex items-center gap-1.5 px-1.5 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-card cursor-pointer transition-colors tracking-wider text-[11px] uppercase disabled:opacity-60"
            title={t.tipSidebarTeach}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t.navTeach}</span>
          </button>
          <button
            type="button"
            onClick={() => handleStartSession("PRACTICE")}
            disabled={creatingMode !== null}
            className="flex items-center gap-1.5 px-1.5 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-card cursor-pointer transition-colors tracking-wider text-[11px] uppercase disabled:opacity-60"
            title={t.tipSidebarPractice}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t.navPractice}</span>
          </button>
          <Link
            href="/draw/new"
            className="ml-auto p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-card cursor-pointer transition-colors"
            title={t.newDrawTitle}
            aria-label={t.newDrawTitle}
          >
            <Edit3 className="w-3.5 h-3.5" />
          </Link>
        </div>

        {/* SESSÕES + inline search */}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[11px] tracking-wider text-muted-foreground uppercase shrink-0">{t.sessionsLabel}</span>
          <div className="relative flex-1 min-w-0">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={t.searchSessions.replace(/^⌕\s*/, "")}
              aria-label={t.searchSessions}
              title={searchCombo ? t.uxSearchSessions(searchCombo) : t.searchSessions}
              className="w-full bg-card border border-border rounded-full pl-6 pr-2 py-1 text-[11px] text-foreground placeholder-muted-foreground focus:border-foreground transition-colors"
            />
          </div>
        </div>

        {/* Segmented filter: Ensino | Prática | Todas */}
        <div className="grid grid-cols-3 bg-card p-0.5 border border-border rounded-full text-[10.5px] uppercase tracking-wider" role="group" aria-label={t.tipSidebarFilter} title={t.tipSidebarFilter}>
          {([
            ["TEACH", t.uxFilterTeach],
            ["PRACTICE", t.uxFilterPractice],
            ["ALL", t.uxFilterAll],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={`py-1 text-center rounded-full cursor-pointer transition-colors ${
                filter === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Track filter: only with 2+ tracks */}
        {showTrackFilter && (
          <select
            value={trackFilter}
            onChange={(e) => changeTrackFilter(e.target.value)}
            aria-label={tt.filterLabel}
            title={tt.filterLabel}
            className="w-full bg-card border border-border rounded px-2 py-1 text-[11px] text-foreground cursor-pointer focus:border-foreground"
          >
            <option value={TRACK_FILTER_ALL}>{tt.filterAll}</option>
            <option value={TRACK_FILTER_NONE}>{tt.filterNone}</option>
            {trackOptions.map((track) => (
              <option key={track.id} value={trackFilterFor(track.id)}>
                {track.archived ? `${track.title} (${tt.archivedBadge})` : track.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-1">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>{t.loading}</span>
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-[11px] px-3">
            {searchQuery
              ? t.noSessionsMatch
              : trackFilter !== TRACK_FILTER_ALL
              ? tt.noSessionsForTrack
              : filter !== "ALL"
              ? t.noSessionsOfMode(filter === "TEACH" ? "TEACHING" : filter)
              : t.noSessions}
          </div>
        ) : (
          filteredSessions.map((session, index) => {
            const isActive = pathname === `/chat/${session.id}`;
            const hasMenu = true;
            // Only TEACH sessions feed the trail (spec Fase 9 §3), so only they can be extracted.
            const canExtract = session.mode === "TEACH";
            const isCursor = index === cursor;
            const now = Date.now();
            const status = rowStatus(session);
            const trackRef = resolveTrackRef(session.track_id, tracks);
            if (renamingId === session.id) {
              return (
                <div key={session.id} className="p-2 rounded border border-border bg-card flex flex-col gap-1">
                  <input
                    autoFocus
                    value={renameDraft}
                    maxLength={TITLE_MAX}
                    aria-label={t.uxRenameLabel}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => void commitRename(session)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void commitRename(session);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setRenamingId(null);
                      }
                    }}
                    className="w-full bg-background border border-border rounded px-2 py-1 text-[11.5px] font-prose text-foreground focus:border-foreground"
                  />
                  {renameError && <p role="alert" className="text-[10px] text-danger break-words">{renameError}</p>}
                </div>
              );
            }
            const menuOpen = menuSessionId === session.id;
            const notice = extractNotice?.sessionId === session.id ? extractNotice : null;
            return (
              <div key={session.id} className="relative group/row">
                <Link
                  href={`/chat/${session.id}`}
                  onContextMenu={(e) => {
                    if (!hasMenu) return;
                    e.preventDefault();
                    setMenuSessionId(session.id);
                  }}
                  aria-current={isActive ? "page" : undefined}
                  className={`group flex items-start gap-2 px-2 py-1.5 rounded border border-transparent transition-all cursor-pointer ${
                    hasMenu ? "pr-7" : ""
                  } ${
                    isActive
                      ? "bg-accent border-border text-foreground"
                      : isCursor
                      ? "bg-card border-border text-foreground"
                      : "hover:bg-card hover:border-accent text-foreground"
                  }`}
                >
                  {getStatusIndicator(session) && <div className="mt-2">{getStatusIndicator(session)}</div>}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[15px] leading-snug truncate font-prose text-foreground group-hover:text-foreground">
                        {session.title || session.topic || t.untitledSession}
                      </span>
                    </div>
                    {trackRef.kind === "track" && (
                      <span
                        className="mt-0.5 inline-flex items-center gap-1 max-w-full text-[9.5px] text-muted-foreground"
                        title={trackRef.track.title}
                      >
                        <TrackDot tone={toneForTrack(trackRef.track.id, tones)} className="w-1.5 h-1.5" />
                        <span className="truncate">{shortTrackTag(trackRef.track.title)}</span>
                      </span>
                    )}
                    {trackRef.kind === "removed" && tracksLoaded && !tracksError && (
                      <span className="mt-0.5 block text-[9.5px] italic text-muted-foreground">{tt.removedTrack}</span>
                    )}
                    <p
                      className={`text-[11px] truncate mt-0.5 ${status.kind === "failed" ? "text-danger" : "text-muted-foreground"}`}
                    >
                      {statusText(status, now)}
                      {status.kind !== "idle" && relativeTime(session.updated_at, now, locale) ? ` · ${relativeTime(session.updated_at, now, locale)}` : ""}
                    </p>
                  </div>
                </Link>

                {hasMenu && (
                  <button
                    type="button"
                    onClick={() => setMenuSessionId(menuOpen ? null : session.id)}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-label={t.sessionMenu}
                    title={t.sessionMenu}
                    className={`absolute right-1 top-1.5 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer transition-opacity ${
                      menuOpen || extractingId === session.id
                        ? "opacity-100"
                        : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                    }`}
                  >
                    {extractingId === session.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}

                {menuOpen && (
                  <div
                    ref={menuRef}
                    role="menu"
                    aria-label={t.sessionMenu}
                    className="absolute right-1 top-8 z-40 min-w-[180px] bg-card border border-border rounded shadow-lg p-1"
                  >
                    {canExtract && (
                      <button
                        type="button"
                        role="menuitem"
                        autoFocus
                        disabled={extractingId !== null}
                        onClick={() => void handleExtract(session.id)}
                        title={t.extractGraphTitle}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[11px] text-foreground hover:bg-accent focus:bg-accent cursor-pointer disabled:cursor-not-allowed disabled:text-muted-foreground"
                      >
                        <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
                        <span>{t.extractGraph}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      autoFocus={!canExtract}
                      onClick={() => startRename(session)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[11px] text-foreground hover:bg-accent focus:bg-accent cursor-pointer"
                    >
                      <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                      <span>{t.uxMenuRename}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => handleExport(session.id)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[11px] text-foreground hover:bg-accent focus:bg-accent cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5 text-muted-foreground" />
                      <span>{t.uxMenuExport}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => openDelete(session)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[11px] text-danger hover:bg-accent focus:bg-accent cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{t.uxMenuDelete}</span>
                    </button>
                  </div>
                )}

                {notice && (
                  <p
                    role={notice.ok ? "status" : "alert"}
                    aria-live="polite"
                    className={`px-2 pb-1 text-[10px] break-words ${notice.ok ? "text-success" : "text-danger"}`}
                  >
                    {notice.text}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer: Background Agents Tray & Settings */}
      <div className="border-t border-border bg-background p-2 flex flex-col gap-0.5">
        {/* Collapsible Background Agents Tray (quiet row; collapsed when empty). Lists only
            queued/running jobs, not the whole job history. */}
        <div className="overflow-hidden">
          <button
            type="button"
            onClick={() => setShowAgentsTray((prev) => !prev)}
            aria-expanded={showAgentsTray}
            title={t.agentsTray}
            className="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-left text-muted-foreground hover:text-foreground hover:bg-card cursor-pointer transition-colors"
          >
            <div className="flex items-center gap-2">
              <Cpu className="w-3.5 h-3.5" />
              <span className="tracking-wider text-[10.5px]">{t.agentsTray}</span>
              {runningJobs.length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 bg-warning/20 text-warning text-[9.5px] rounded-full border border-warning/40">
                  {runningJobs.length}
                </span>
              )}
              {failedJobs.length > 0 && (
                <span
                  className="ml-1 px-1.5 py-0.2 bg-danger/10 text-danger text-[9.5px] rounded-full border border-danger/40"
                  title={t.agentsFailedBadge(failedJobs.length)}
                  aria-label={t.agentsFailedBadge(failedJobs.length)}
                >
                  !
                </span>
              )}
            </div>
            {showAgentsTray ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>

          {showAgentsTray && (
            <div className="p-2 border-t border-border flex flex-col gap-1.5 bg-background">
              {runningJobs.length === 0 && failedJobs.length === 0 ? (
                <p className="text-[10.5px] text-muted-foreground italic py-1 text-center">
                  {t.agentsIdle}
                </p>
              ) : (
                runningJobs.map((job) => renderJob(job))
              )}
              {failedJobs.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowFailedJobs((prev) => !prev)}
                    aria-expanded={showFailedJobs}
                    className="flex items-center justify-between px-1 py-0.5 text-[10.5px] text-danger hover:bg-card rounded cursor-pointer"
                  >
                    <span>{t.agentsFailed(failedJobs.length)}</span>
                    {showFailedJobs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                  {showFailedJobs && failedJobs.map((job) => renderJob(job))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Session trash: only while it holds something */}
        {trash.entries.length > 0 && (
          <button
            type="button"
            onClick={() => setTrashOpen(true)}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-card border border-transparent hover:border-border cursor-pointer transition-colors text-[11px]"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span className="tracking-wider text-[10.5px]">{trashText(locale).entry(trash.entries.length)}</span>
          </button>
        )}

        {/* Settings Navigation Link */}
        <Link
          href="/settings"
          className="flex items-center gap-2 px-2.5 py-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-card border border-transparent hover:border-border cursor-pointer transition-colors text-[11px]"
        >
          <Settings className="w-3.5 h-3.5" />
          <span className="tracking-wider text-[10.5px]">{t.settingsLabel}</span>
          <SettingsComboHint />
        </Link>
      </div>
      <SessionTrashDialog open={trashOpen} onClose={() => setTrashOpen(false)} trash={trash} />
      <ConfirmDialog
        open={deleteTarget !== null}
        fixed
        danger
        title={t.uxDeleteTitle}
        body={t.uxDeleteBody(deleteTarget?.title || deleteTarget?.topic || t.untitledSession)}
        confirmLabel={t.uxDeleteConfirm}
        busyLabel={t.uxDeleteBusy}
        busy={deleteBusy}
        error={deleteError}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      >
        <label className="flex items-start gap-2 mb-4 font-ui text-[11.5px] text-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={deleteNodes}
            onChange={(e) => setDeleteNodes(e.target.checked)}
            className="mt-0.5 accent-foreground"
          />
          <span>{t.uxDeleteNodes}</span>
        </label>
      </ConfirmDialog>
    </aside>
    </>
  );
}
