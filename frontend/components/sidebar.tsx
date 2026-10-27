"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import type { BackgroundJobStatus, SessionMode, SessionRecord } from "@/lib/types";
import { chatMarkdownUrl, createChat, deleteChat, extractSessionToGraph, listChats, renameChat, retryJob } from "@/lib/api";
import {
  filterByMode,
  fuzzyFilter,
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
import { requestComposerFocus } from "./composer-focus";
import { SettingsComboHint } from "./use-combo-label";

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

const EXTRACT_NOTICE_MS = 6000;

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

  // Uncontrolled by default (the root layout passes nothing): remembered per browser.
  const [collapsedState, setCollapsedState] = useState(false);
  useEffect(() => setCollapsedState(loadCollapsed()), []);
  const collapsed = collapsedProp ?? collapsedState;
  const onToggleCollapse = () => {
    if (onToggleProp) return onToggleProp();
    setCollapsedState((prev) => {
      saveCollapsed(!prev);
      return !prev;
    });
  };
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<Record<string, string>>({});
  // `activeJobs` holds every known job record; only queued/running ones are "busy".
  const runningJobs = activeJobs.filter(
    (j) => j.status === "queued" || j.status === "running"
  );

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
    ["session:updated", "plan:updated", "dock:opened", "dock:resolved"],
    () => {
      void fetchSessionList();
    }
  );

  const filteredSessions = useMemo(
    () => fuzzyFilter(filterByMode(sessions, filter), searchQuery, (s) => [s.title, s.topic]),
    [sessions, filter, searchQuery],
  );

  useEffect(() => setCursor(-1), [searchQuery, filter]);

  // Global shortcuts (registry ids; rebindable in Settings → Teclado).
  useEffect(() => {
    setSearchCombo(formatCombo(comboFor("sessionSearch"), /Mac|iPhone|iPad/.test(navigator.platform)));
  }, []);
  useShortcut("toggleSidebar", () => onToggleCollapse());
  useShortcut("sessionSearch", () => {
    if (collapsed) {
      onToggleCollapse();
      setPendingSearchFocus(true);
    } else {
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  });
  useEffect(() => {
    if (!pendingSearchFocus || collapsed) return;
    searchRef.current?.focus();
    setPendingSearchFocus(false);
  }, [pendingSearchFocus, collapsed]);
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
    if (session.status === "active") {
      return (
        <span
          className="inline-block w-2 h-2 rounded-full bg-muted-foreground shrink-0"
          title={t.statusIdle}
        />
      );
    }
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-border shrink-0"
        title={t.statusCompleted}
      />
    );
  };

  if (collapsed) {
    return (
      <aside className="w-14 bg-background border-r border-border flex flex-col justify-between items-center py-4 select-none shrink-0 transition-all duration-200 z-30">
        <div className="flex flex-col items-center gap-4 w-full">
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

  return (
    <aside className="w-[260px] bg-background border-r border-border flex flex-col justify-between select-none shrink-0 h-screen overflow-hidden text-xs font-ui transition-all duration-200 z-30">
      {/* Top Header & Quick Actions */}
      <div className="p-3 border-b border-border flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 group cursor-pointer"
          >
            <span className="font-title text-base font-bold text-foreground tracking-tight group-hover:text-foreground transition-colors">
              learnharness
            </span>
          </Link>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-card rounded cursor-pointer transition-colors"
            title={t.collapseSidebar}
            aria-label={t.collapseSidebar}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>

        {/* 3 Quick Action Buttons */}
        <div className="grid grid-cols-3 gap-1 pt-1">
          <button
            type="button"
            onClick={() => handleStartSession("TEACH")}
            disabled={creatingMode !== null}
            className="flex items-center justify-center gap-1 py-1.5 px-2 bg-card hover:bg-accent text-foreground border border-border rounded cursor-pointer transition-colors tracking-wider font-semibold active:scale-[0.98]"
            title={t.newTeachTitle}
          >
            <Plus className="w-3 h-3 text-foreground" />
            <span className="text-[10px]">TEACH</span>
          </button>

          <button
            type="button"
            onClick={() => handleStartSession("PRACTICE")}
            disabled={creatingMode !== null}
            className="flex items-center justify-center gap-1 py-1.5 px-2 bg-card hover:bg-accent text-foreground border border-border rounded cursor-pointer transition-colors tracking-wider font-semibold active:scale-[0.98]"
            title={t.newPracticeTitle}
          >
            <Sparkles className="w-3 h-3 text-foreground" />
            <span className="text-[10px]">PRACTICE</span>
          </button>

          <Link
            href="/draw/new"
            className="flex items-center justify-center gap-1 py-1.5 px-2 bg-card hover:bg-accent text-foreground border border-border rounded cursor-pointer transition-colors tracking-wider font-semibold active:scale-[0.98]"
            title={t.newDrawTitle}
          >
            <Edit3 className="w-3 h-3 text-foreground" />
            <span className="text-[10px]">{t.drawShort}</span>
          </Link>
        </div>

        {/* Search input */}
        <div className="relative mt-1">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={t.searchSessions}
            aria-label={t.searchSessions}
            title={searchCombo ? t.uxSearchSessions(searchCombo) : undefined}
            className="w-full bg-card border border-border rounded pl-8 pr-2 py-1.5 text-[11px] text-foreground placeholder-muted-foreground focus:border-foreground transition-colors"
          />
        </div>

        {/* Segmented filter: Ensino | Todas | Prática */}
        <div className="grid grid-cols-3 bg-card p-0.5 border border-border rounded mt-0.5 text-[10.5px]" role="group">
          {([
            ["TEACH", t.uxFilterTeach],
            ["ALL", t.uxFilterAll],
            ["PRACTICE", t.uxFilterPractice],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={`py-1 text-center rounded cursor-pointer transition-colors font-medium ${
                filter === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
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
                  className={`group flex items-start gap-2 p-2 rounded border border-transparent transition-all cursor-pointer ${
                    hasMenu ? "pr-7" : ""
                  } ${
                    isActive
                      ? "bg-accent border-border text-foreground"
                      : isCursor
                      ? "bg-card border-border text-foreground"
                      : "hover:bg-card hover:border-accent text-foreground"
                  }`}
                >
                  <div className="mt-1">{getStatusIndicator(session)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-medium text-[11.5px] truncate font-prose text-foreground group-hover:text-foreground">
                        {session.title || session.topic || t.untitledSession}
                      </span>
                      <span className="text-[9px] uppercase px-1 py-0.2 bg-background border border-border text-muted-foreground rounded shrink-0">
                        {session.mode}
                      </span>
                    </div>
                    {session.topic && session.topic !== session.title && (
                      <p className="text-[10px] text-muted-foreground truncate mt-0.5 font-prose">
                        {session.topic}
                      </p>
                    )}
                    <p
                      className={`text-[10px] truncate mt-0.5 ${
                        status.kind === "failed" ? "text-danger" : status.kind === "idle" ? "text-muted-foreground" : "text-warning"
                      }`}
                    >
                      {statusText(status, now)}
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
      <div className="border-t border-border bg-background p-2 flex flex-col gap-1.5">
        {/* Collapsible Background Agents Tray */}
        <div className="bg-card border border-border rounded overflow-hidden">
          <button
            type="button"
            onClick={() => setShowAgentsTray((prev) => !prev)}
            className="w-full flex items-center justify-between p-2 text-left text-[11px] text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          >
            <div className="flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="font-semibold tracking-wider text-[10px]">
                {t.agentsTray}
              </span>
              {runningJobs.length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 bg-warning/20 text-warning text-[9.5px] rounded-full border border-warning/40">
                  {runningJobs.length}
                </span>
              )}
            </div>
            {showAgentsTray ? (
              <ChevronUp className="w-3 h-3 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            )}
          </button>

          {showAgentsTray && (
            <div className="p-2 border-t border-border flex flex-col gap-1.5 bg-background">
              {activeJobs.length === 0 ? (
                <p className="text-[10.5px] text-muted-foreground italic py-1 text-center">
                  {t.agentsIdle}
                </p>
              ) : (
                activeJobs.map((job) => {
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
                      {err && canRetry && (
                        <p className="text-[9.5px] text-danger break-words line-clamp-3" title={err}>
                          {err}
                        </p>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

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
  );
}
