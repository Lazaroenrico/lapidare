"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Cpu,
  Edit3,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import type { BackgroundJobStatus, SessionMode, SessionRecord } from "@/lib/types";
import { createChat, listChats, retryJob } from "@/lib/api";
import { useEventSubscription, useServerEvents } from "./server-events";
import { useLocale } from "./locale-provider";

type FilterMode = "TEACHING" | "PRACTICE" | "ALL";

interface SidebarProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function Sidebar({ collapsed = false, onToggleCollapse }: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { activeJobs } = useServerEvents();
  const { t } = useLocale();
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
  const [filter, setFilter] = useState<FilterMode>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [showAgentsTray, setShowAgentsTray] = useState<boolean>(false);
  const [creatingMode, setCreatingMode] = useState<SessionMode | null>(null);

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

  const filteredSessions = useMemo(() => {
    return sessions.filter((s) => {
      // Filter by TEACHING vs PRACTICE vs ALL
      if (filter === "TEACHING" && s.mode !== "TEACH") return false;
      if (filter === "PRACTICE" && s.mode !== "PRACTICE") return false;

      // Filter by search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const titleMatch = s.title?.toLowerCase().includes(query);
        const topicMatch = s.topic?.toLowerCase().includes(query);
        return titleMatch || topicMatch;
      }
      return true;
    });
  }, [sessions, filter, searchQuery]);

  const handleStartSession = async (mode: SessionMode) => {
    try {
      setCreatingMode(mode);
      const newSession = await createChat({
        mode,
        topic: mode === "TEACH" ? "New Teaching Session" : "Cold Retrieval Practice",
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
          className="inline-block w-2 h-2 rounded-full bg-[#f87171] shrink-0"
          title={session.error ? `${label}: ${session.error}` : label}
          aria-label={label}
        />
      );
    }
    if (session.status === "waiting_quiz") {
      return (
        <span
          className="inline-block w-2 h-2 rounded-full bg-[#e0a030] animate-pulse shrink-0"
          title={t.statusWaiting}
        />
      );
    }
    if (exec === "queued" || exec === "running") {
      return (
        <span
          className="inline-block w-2 h-2 rounded-full bg-[#8d8d8d] animate-ping shrink-0"
          title={t.statusTeaching}
        />
      );
    }
    if (session.status === "active") {
      return (
        <span
          className="inline-block w-2 h-2 rounded-full bg-[#8d8d8d] shrink-0"
          title={t.statusIdle}
        />
      );
    }
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-[#434343] shrink-0"
        title={t.statusCompleted}
      />
    );
  };

  if (collapsed) {
    return (
      <aside className="w-14 bg-[#141414] border-r border-[#434343] flex flex-col justify-between items-center py-4 select-none shrink-0 transition-all duration-200 z-30">
        <div className="flex flex-col items-center gap-4 w-full">
          <button
            type="button"
            onClick={onToggleCollapse}
            className="p-2 text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#1c1c1c] rounded cursor-pointer transition-colors"
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <div className="w-8 h-px bg-[#434343]" />

          <button
            type="button"
            onClick={() => handleStartSession("TEACH")}
            disabled={creatingMode !== null}
            className="p-2 text-[#e6e6e6] hover:bg-[#2a2a2a] rounded cursor-pointer transition-colors"
            title="+ TEACHING"
          >
            <Plus className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => handleStartSession("PRACTICE")}
            disabled={creatingMode !== null}
            className="p-2 text-[#e6e6e6] hover:bg-[#2a2a2a] rounded cursor-pointer transition-colors"
            title="◇ PRACTICE"
          >
            <Sparkles className="w-4 h-4" />
          </button>

          <Link
            href="/draw/new"
            className="p-2 text-[#e6e6e6] hover:bg-[#2a2a2a] rounded cursor-pointer transition-colors"
            title="✎ EXCALIDRAW"
          >
            <Edit3 className="w-4 h-4" />
          </Link>
        </div>

        <div className="flex flex-col items-center gap-3 w-full">
          {runningJobs.length > 0 && (
            <div
              className="p-2 text-[#e0a030] animate-pulse"
              title={`${runningJobs.length} Background Agent(s) running`}
            >
              <Cpu className="w-4 h-4" />
            </div>
          )}

          <Link
            href="/settings"
            className="p-2 text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#1c1c1c] rounded cursor-pointer transition-colors"
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </Link>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-[260px] bg-[#141414] border-r border-[#434343] flex flex-col justify-between select-none shrink-0 h-screen overflow-hidden text-xs font-ui transition-all duration-200 z-30">
      {/* Top Header & Quick Actions */}
      <div className="p-3 border-b border-[#434343] flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 group cursor-pointer"
          >
            <span className="font-title text-base font-bold text-[#e6e6e6] tracking-tight group-hover:text-white transition-colors">
              learnharness
            </span>
          </Link>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="p-1 text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#1c1c1c] rounded cursor-pointer transition-colors"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
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
            className="flex items-center justify-center gap-1 py-1.5 px-2 bg-[#1c1c1c] hover:bg-[#2a2a2a] text-[#e6e6e6] border border-[#434343] rounded cursor-pointer transition-colors tracking-wider font-semibold active:scale-[0.98]"
            title="New Teaching Session"
          >
            <Plus className="w-3 h-3 text-[#e6e6e6]" />
            <span className="text-[10px]">TEACH</span>
          </button>

          <button
            type="button"
            onClick={() => handleStartSession("PRACTICE")}
            disabled={creatingMode !== null}
            className="flex items-center justify-center gap-1 py-1.5 px-2 bg-[#1c1c1c] hover:bg-[#2a2a2a] text-[#e6e6e6] border border-[#434343] rounded cursor-pointer transition-colors tracking-wider font-semibold active:scale-[0.98]"
            title="Practice Problem Sets"
          >
            <Sparkles className="w-3 h-3 text-[#e6e6e6]" />
            <span className="text-[10px]">PRACTICE</span>
          </button>

          <Link
            href="/draw/new"
            className="flex items-center justify-center gap-1 py-1.5 px-2 bg-[#1c1c1c] hover:bg-[#2a2a2a] text-[#e6e6e6] border border-[#434343] rounded cursor-pointer transition-colors tracking-wider font-semibold active:scale-[0.98]"
            title="Memory Retrieval Drawing"
          >
            <Edit3 className="w-3 h-3 text-[#e6e6e6]" />
            <span className="text-[10px]">DRAW</span>
          </Link>
        </div>

        {/* Search input */}
        <div className="relative mt-1">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8d8d8d]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="⌕ Search sessions..."
            className="w-full bg-[#1c1c1c] border border-[#434343] rounded pl-8 pr-2 py-1.5 text-[11px] text-[#e6e6e6] placeholder-[#8d8d8d] focus:border-[#e6e6e6] transition-colors"
          />
        </div>

        {/* Segmented Filter: STRICTLY TEACHING | PRACTICE | ALL */}
        <div className="grid grid-cols-3 bg-[#1c1c1c] p-0.5 border border-[#434343] rounded mt-0.5 text-[10.5px]">
          <button
            type="button"
            onClick={() => setFilter("TEACHING")}
            className={`py-1 text-center rounded cursor-pointer transition-colors font-medium ${
              filter === "TEACHING"
                ? "bg-[#2a2a2a] text-[#e6e6e6]"
                : "text-[#8d8d8d] hover:text-[#e6e6e6]"
            }`}
          >
            TEACHING
          </button>
          <button
            type="button"
            onClick={() => setFilter("PRACTICE")}
            className={`py-1 text-center rounded cursor-pointer transition-colors font-medium ${
              filter === "PRACTICE"
                ? "bg-[#2a2a2a] text-[#e6e6e6]"
                : "text-[#8d8d8d] hover:text-[#e6e6e6]"
            }`}
          >
            PRACTICE
          </button>
          <button
            type="button"
            onClick={() => setFilter("ALL")}
            className={`py-1 text-center rounded cursor-pointer transition-colors font-medium ${
              filter === "ALL"
                ? "bg-[#2a2a2a] text-[#e6e6e6]"
                : "text-[#8d8d8d] hover:text-[#e6e6e6]"
            }`}
          >
            ALL
          </button>
        </div>
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-1">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-[#8d8d8d] gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Loading...</span>
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="py-8 text-center text-[#8d8d8d] text-[11px] px-3">
            {searchQuery
              ? "No sessions match your search."
              : filter !== "ALL"
              ? `No ${filter.toLowerCase()} sessions yet.`
              : "No sessions recorded. Start one above!"}
          </div>
        ) : (
          filteredSessions.map((session) => {
            const isActive = pathname === `/chat/${session.id}`;
            return (
              <Link
                key={session.id}
                href={`/chat/${session.id}`}
                className={`group flex items-start gap-2 p-2 rounded border border-transparent transition-all cursor-pointer ${
                  isActive
                    ? "bg-[#2a2a2a] border-[#434343] text-white"
                    : "hover:bg-[#1c1c1c] hover:border-[#2a2a2a] text-[#e6e6e6]"
                }`}
              >
                <div className="mt-1">{getStatusIndicator(session)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-[11.5px] truncate font-prose text-[#e6e6e6] group-hover:text-white">
                      {session.title || session.topic || "Untitled Session"}
                    </span>
                    <span className="text-[9px] uppercase px-1 py-0.2 bg-[#141414] border border-[#434343] text-[#8d8d8d] rounded shrink-0">
                      {session.mode}
                    </span>
                  </div>
                  {session.topic && session.topic !== session.title && (
                    <p className="text-[10px] text-[#8d8d8d] truncate mt-0.5 font-prose">
                      {session.topic}
                    </p>
                  )}
                </div>
              </Link>
            );
          })
        )}
      </div>

      {/* Footer: Background Agents Tray & Settings */}
      <div className="border-t border-[#434343] bg-[#141414] p-2 flex flex-col gap-1.5">
        {/* Collapsible Background Agents Tray */}
        <div className="bg-[#1c1c1c] border border-[#434343] rounded overflow-hidden">
          <button
            type="button"
            onClick={() => setShowAgentsTray((prev) => !prev)}
            className="w-full flex items-center justify-between p-2 text-left text-[11px] text-[#8d8d8d] hover:text-[#e6e6e6] cursor-pointer transition-colors"
          >
            <div className="flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-[#8d8d8d]" />
              <span className="font-semibold tracking-wider text-[10px]">
                ~ BACKGROUND AGENTS
              </span>
              {runningJobs.length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 bg-[#e0a030]/20 text-[#e0a030] text-[9.5px] rounded-full border border-[#e0a030]/40">
                  {runningJobs.length}
                </span>
              )}
            </div>
            {showAgentsTray ? (
              <ChevronUp className="w-3 h-3 text-[#8d8d8d]" />
            ) : (
              <ChevronDown className="w-3 h-3 text-[#8d8d8d]" />
            )}
          </button>

          {showAgentsTray && (
            <div className="p-2 border-t border-[#434343] flex flex-col gap-1.5 bg-[#141414]">
              {activeJobs.length === 0 ? (
                <p className="text-[10.5px] text-[#8d8d8d] italic py-1 text-center">
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
                      className="p-1.5 bg-[#1c1c1c] border border-[#434343] rounded flex flex-col gap-1 text-[10.5px]"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-medium text-[#e6e6e6] truncate" title={job.kind}>
                          {job.label || job.kind}
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          <span
                            className={`text-[9px] px-1 py-0.2 rounded border ${
                              busy
                                ? "bg-[#e0a030]/10 text-[#e0a030] border-[#e0a030]/30 animate-pulse"
                                : canRetry
                                ? "bg-[#f87171]/10 text-[#f87171] border-[#f87171]/40"
                                : "bg-[#2a2a2a] text-[#8d8d8d] border-[#434343]"
                            }`}
                          >
                            {job.status}
                          </span>
                          {canRetry && (
                            <button
                              type="button"
                              onClick={() => void handleRetryJob(job)}
                              disabled={retryingJobId === job.job_id}
                              className="p-0.5 rounded text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#2a2a2a] cursor-pointer disabled:cursor-not-allowed transition-colors"
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
                        <p className="text-[9.5px] text-[#f87171] break-words line-clamp-3" title={err}>
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
          className="flex items-center gap-2 px-2.5 py-1.5 rounded text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#1c1c1c] border border-transparent hover:border-[#434343] cursor-pointer transition-colors text-[11px]"
        >
          <Settings className="w-3.5 h-3.5" />
          <span className="tracking-wider text-[10.5px]">⚙ SETTINGS</span>
        </Link>
      </div>
    </aside>
  );
}
