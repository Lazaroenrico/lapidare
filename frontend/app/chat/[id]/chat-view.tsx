"use client";

import { useLocale } from "@/components/locale-provider";
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { routeParam } from "@/lib/route-param";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Compass,
  Edit3,
  FileText,
  GitBranch,
  Loader2,
  Mic,
  MicOff,
  RotateCcw,
  Send,
  Sparkles,
} from "lucide-react";
import type { EffortLevel, ModelSlotConfig, SessionRecord, SseEventType } from "@/lib/types";
import { buildTranscript, normalizePhase } from "@/lib/session-wire";
import {
  createDemo,
  createDrawing,
  dismissPracticeProblem,
  extractSessionToGraph,
  getBackgroundJobs,
  getChat,
  getGraphSnapshot,
  getSetupStatus,
  abortChat,
  dismissQuestion,
  renameChat,
  resumeChat,
  sendChatMessage,
  steerChat,
  updateChatSettings,
} from "@/lib/api";
import {
  compactionAnchorId,
  isRunningStatus,
  resolveEsc,
  steerReducer,
  visibleLocalSteers,
} from "@/lib/session-ux";
import { useShortcut } from "@/components/use-shortcut";
import { appendDictation, useDictation } from "@/components/use-dictation";
import { NavDrawerButton } from "@/components/nav-drawer";
import { SessionFindBar } from "@/components/session-find-bar";
import {
  CompactingPlaceholder,
  CompactionDivider,
  ConfirmDialog,
  LocalSteerBubble,
  SessionTitle,
} from "@/components/session-ux";
import { modelChoicePayload, type ModelChoice } from "@/lib/model-choice";
import {
  activeProblem,
  buildPracticeTranscript,
  dockState,
  practiceCounts,
  type DockSubmission,
} from "@/lib/practice";
import { formatTokens } from "@/lib/usage";
import { ModelPicker } from "@/components/model-picker";
import { useEventSubscription } from "@/components/server-events";
import { LessonProse } from "@/components/lesson-prose";
import { QuestionDock } from "@/components/question-dock";
import { PlanWindow } from "@/components/plan-window";
import { AnsweredQuestionCard, PhaseChip, PhaseDivider, ProbeDoneCard } from "@/components/transcript-cards";
import { LevelingDoneCard, LevelingPhaseChip, LevelingProgressBand } from "@/components/leveling-ui";
import { EngineErrorCard } from "@/components/engine-error-card";
import { OPEN_MODEL_PICKER_EVENT, dispatchCommand } from "@/lib/command-events";
import { showsEngineErrorCard } from "@/lib/engine-error";
import { decodeLevelingProgress, isLevelingSession } from "@/lib/leveling";
import { SourceCitationPane } from "@/components/source-citation-pane";
import { DismissProblemDialog, PracticeDock, PracticeTranscript } from "@/components/practice-session";
import { DemoIframe } from "@/components/demo-iframe";
import { JobCard, LearnerSteerBadge } from "@/components/job-cards";

const SESSION_EVENTS: SseEventType[] = ["session:updated", "dock:opened", "dock:resolved", "plan:updated", "usage:updated"];
const FLASH_MS = 1800;
const EXTRACT_NOTICE_MS = 6000;

/** "#message-<id>" → "<id>" (null for any other hash). */
function messageIdFromHash(hash: string): string | null {
  const m = /^#message-(.+)$/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export function ChatView() {
  const {locale, t} = useLocale();
  const id = routeParam(usePathname(), "chat") ?? "";
  const router = useRouter();

  const [session, setSession] = useState<SessionRecord | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Message input state
  const [inputMessage, setInputMessage] = useState<string>("");
  const [isSending, setIsSending] = useState<boolean>(false);
  // Inline feedback for failed actions (send / demo / resume) — never alert()
  const [actionError, setActionError] = useState<string | null>(null);
  const [isResuming, setIsResuming] = useState<boolean>(false);

  // Citation drawer state
  const [citationDrawerOpen, setCitationDrawerOpen] = useState<boolean>(false);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [selectedParagraph, setSelectedParagraph] = useState<string | null>(null);

  // Drawing & Interactive Demo state
  const [isCreatingDrawing, setIsCreatingDrawing] = useState<boolean>(false);
  const [showDemo, setShowDemo] = useState<boolean>(false);
  const [demoSlug, setDemoSlug] = useState<string | null>(null);
  // `demo_builder` job queued by the ⚡ button; resolved via SSE `jobs:updated` (notify -> fetch).
  const [demoJobId, setDemoJobId] = useState<string | null>(null);
  const isSpawningDemo = demoJobId !== null;

  // PRACTICE: graph node names for the target chips (notify -> fetch on graph:updated).
  const [nodeNames, setNodeNames] = useState<Map<string, string>>(new Map());
  const [dismissOpen, setDismissOpen] = useState(false);
  const [dismissBusy, setDismissBusy] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  // TEACH: "Extrair para o grafo" (POST /api/graph/extract/{id}); the job shows in BACKGROUND AGENTS.
  const [extracting, setExtracting] = useState(false);
  const [extractNotice, setExtractNotice] = useState<string | null>(null);
  const extractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
  }, []);

  const settleDemoJob = (job: { status: string; result_id?: string | null; error?: string | null }) => {
    if (job.status === "completed" && job.result_id) {
      setDemoJobId(null);
      setDemoSlug(job.result_id);
      setShowDemo(true);
    } else if (job.status === "failed" || job.status === "interrupted") {
      setDemoJobId(null);
      setActionError(`${t.demoFailed} ${job.error ?? ""}`.trim());
    }
  };

  const handleSpawnDemo = async () => {
    if (!session || demoJobId) return;
    setActionError(null);
    try {
      const job = await createDemo({
        title: `Simulador: ${session.title || session.topic}`,
        topic: session.title || session.topic,
        description: `Simulador interativo para explorar os parâmetros de ${session.title || session.topic}.`,
        session_id: session.id,
      });
      setDemoJobId(job.job_id);
      settleDemoJob(job);
    } catch (err: any) {
      console.error("Failed to spawn demo:", err);
      setDemoJobId(null);
      setActionError(`${t.demoFailed} ${err?.message ?? ""}`.trim());
    }
  };

  useEventSubscription("jobs:updated", (frame) => {
    const changed = (frame.data as { job_id?: string } | null)?.job_id;
    if (!demoJobId || (changed && changed !== demoJobId)) return;
    void getBackgroundJobs()
      .then((jobs) => {
        const job = jobs.find((j) => j.job_id === demoJobId);
        if (job) settleDemoJob(job);
      })
      .catch(() => undefined);
  });

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Fase 12: steers typed while the agent runs, the Esc chain, ⌘F and inline rename.
  const [localSteers, dispatchSteer] = useReducer(steerReducer, []);
  const steerSeqRef = useRef(0);
  const [escDialog, setEscDialog] = useState<"question" | "abort" | null>(null);
  const [escBusy, setEscBusy] = useState(false);
  const [escError, setEscError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findSignal, setFindSignal] = useState(0);
  const [renaming, setRenaming] = useState(false);

  // Fetch session data (notify -> fetch pattern)
  const fetchSessionData = async () => {
    if (!id) return;
    try {
      const data = await getChat(id);
      setSession(data);
      setError(null);
    } catch (err: any) {
      console.error("Failed to fetch session:", err);
      setError(err?.message || t.sessionNotFound);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchSessionData();
  }, [id]);

  // Subscribe to SSE events for real-time reactivity without polling
  useEventSubscription(SESSION_EVENTS, () => {
    void fetchSessionData();
  });

  const isPracticeSession = session?.mode === "PRACTICE";

  // TEACH follow-up bar dictation (mic button and ⌘D via lib/command-events claim rules).
  const followUpRef = useRef<HTMLFormElement | null>(null);
  const dictation = useDictation(locale, { field: followUpRef, enabled: Boolean(session) && !isPracticeSession });
  dictation.setSink((spoken) => setInputMessage((prev) => appendDictation(prev, spoken)));

  const loadNodeNames = React.useCallback(() => {
    getGraphSnapshot()
      .then((g) => setNodeNames(new Map(g.nodes.map((n) => [n.id, n.name]))))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (isPracticeSession) loadNodeNames();
  }, [isPracticeSession, loadNodeNames]);
  useEventSubscription("graph:updated", () => {
    if (isPracticeSession) loadNodeNames();
  });

  // Deep link #message-<id>: scroll to the message and flash it (on load and on hashchange).
  // While a deep link is pending, the auto-scroll-to-bottom stays out of the way.
  const pendingAnchorRef = useRef<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollToAnchor = React.useCallback((messageId: string): boolean => {
    const el = document.getElementById(`message-${messageId}`);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("message-flash");
    // Restart the animation even when the same message is targeted twice.
    void el.offsetWidth;
    el.classList.add("message-flash");
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => el.classList.remove("message-flash"), FLASH_MS);
    return true;
  }, []);

  useEffect(() => {
    pendingAnchorRef.current = messageIdFromHash(window.location.hash);
    const onHash = () => {
      const target = messageIdFromHash(window.location.hash);
      if (target && !scrollToAnchor(target)) pendingAnchorRef.current = target;
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [id, scrollToAnchor]);

  // Scroll to bottom on message update (unless a deep link is still being resolved)
  useEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (anchor) {
      if (scrollToAnchor(anchor)) pendingAnchorRef.current = null;
      return;
    }
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [
    session?.messages.length,
    session?.pending_quiz?.quiz_id,
    session?.practice.problems.length,
    session?.practice.active_problem_id,
    scrollToAnchor,
  ]);

  // Model chip: effective slot of the session (override or the strong slot).
  const [strongSlot, setStrongSlot] = useState<ModelSlotConfig | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  useEffect(() => {
    getSetupStatus()
      .then((s) => setStrongSlot(s.config?.slots?.strong ?? null))
      .catch(() => setStrongSlot(null));
  }, []);
  const activeSlot: ModelSlotConfig | null = session?.effective_slot ?? session?.slot_override ?? strongSlot;
  const modelValue: ModelChoice = {
    model: activeSlot?.model || "auto",
    effort: (activeSlot?.effort as EffortLevel | undefined) ?? "medium",
  };

  const handleModelChange = async (next: ModelChoice) => {
    if (!id || modelBusy) return;
    setModelBusy(true);
    setActionError(null);
    try {
      const updated = await updateChatSettings(id, modelChoicePayload(next));
      if (updated) setSession(updated);
      else await fetchSessionData();
    } catch (err) {
      setActionError(`${t.modelChangeFailed} ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setModelBusy(false);
    }
  };

  // Handle open citation drawer (stable: every memoized LessonProse receives it)
  const handleOpenCitation = useCallback((sourceName: string, paragraphId: string) => {
    setSelectedSource(sourceName);
    setSelectedParagraph(paragraphId);
    setCitationDrawerOpen(true);
  }, []);

  // Handle send message
  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputMessage.trim() || isSending || !id) return;

    const textToSend = inputMessage.trim();
    setInputMessage("");
    if (isRunningStatus(session?.execution_status)) {
      void sendSteer(textToSend);
      return;
    }
    setIsSending(true);
    setActionError(null);

    try {
      const res = await sendChatMessage(id, textToSend);
      if (res.session) {
        setSession(res.session);
      } else {
        await fetchSessionData();
      }
    } catch (err: any) {
      console.error("Failed to send message:", err);
      // Restore the draft so the learner doesn't lose it, and explain inline.
      setInputMessage((prev) => prev || textToSend);
      setActionError(`${t.sendFailed} ${err?.message ?? ""}`.trim());
    } finally {
      setIsSending(false);
    }
  };

  // While a turn runs, the message goes to /steer and shows "na fila" until delivered.
  const sendSteer = async (content: string, localId = `steer-${++steerSeqRef.current}`) => {
    if (!id) return;
    dispatchSteer({ type: "send", localId, content, baseline: session?.messages.length ?? 0 });
    try {
      const updated = await steerChat(id, content);
      dispatchSteer({ type: "accepted", localId });
      if (updated) setSession(updated);
      else await fetchSessionData();
    } catch (err) {
      dispatchSteer({ type: "failed", localId });
      setActionError(`${t.sendFailed} ${err instanceof Error ? err.message : ""}`.trim());
    }
  };

  // PRACTICE dock: attempt / next / free text (POST /messages with `kind`).
  const handlePracticeSubmit = async (submission: DockSubmission): Promise<boolean> => {
    if (id && isRunningStatus(session?.execution_status) && submission.content) {
      void sendSteer(submission.content);
      return true;
    }
    if (!id || isSending) return false;
    setIsSending(true);
    setActionError(null);
    try {
      const res = await sendChatMessage(id, submission.content, submission.kind, { silent: true });
      if (res.session) setSession(res.session);
      else await fetchSessionData();
      return true;
    } catch (err) {
      setActionError(`${t.sendFailed} ${err instanceof Error ? err.message : ""}`.trim());
      return false;
    } finally {
      setIsSending(false);
    }
  };

  const handleConfirmDismiss = async () => {
    if (!id || dismissBusy) return;
    setDismissBusy(true);
    setDismissError(null);
    try {
      const updated = await dismissPracticeProblem(id);
      if (updated) setSession(updated);
      else await fetchSessionData();
      setDismissOpen(false);
    } catch (err) {
      setDismissError(`${t.dismissProblemFailed} ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setDismissBusy(false);
    }
  };

  const handleExtract = async () => {
    if (!id || extracting) return;
    setExtracting(true);
    setActionError(null);
    try {
      await extractSessionToGraph(id);
      setExtractNotice(t.extractQueued);
      if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
      extractTimerRef.current = setTimeout(() => setExtractNotice(null), EXTRACT_NOTICE_MS);
    } catch (err) {
      setActionError(`${t.extractFailed} ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setExtracting(false);
    }
  };

  // Resume a failed/interrupted run (POST /api/chats/{id}/resume). The SSE
  // `session:updated` notification triggers any follow-up fetch.
  const handleResume = async (restartDiagnostic: boolean) => {
    if (!id || isResuming) return;
    setIsResuming(true);
    setActionError(null);
    try {
      setSession(await resumeChat(id, restartDiagnostic));
    } catch (err: any) {
      console.error("Failed to resume session:", err);
      setActionError(err?.message || t.sessionFailed);
    } finally {
      setIsResuming(false);
    }
  };

  // Esc (useShortcut "abort"): pending question → active problem → running turn.
  useShortcut("abort", () => {
    if (!session) return false;
    const action = resolveEsc({
      overlayOpen: Boolean(escDialog) || dismissOpen || findOpen || renaming || citationDrawerOpen,
      pendingQuestion: Boolean(session.pending_quiz),
      activeProblem: session.mode === "PRACTICE" && Boolean(activeProblem(session.practice)),
      running: isRunningStatus(session.execution_status),
    });
    if (action === "none") return false;
    if (action === "dismiss-problem") {
      setDismissError(null);
      setDismissOpen(true);
      return;
    }
    setEscError(null);
    setEscDialog(action === "dismiss-question" ? "question" : "abort");
  });

  const handleConfirmEsc = async () => {
    if (!id || !escDialog || escBusy) return;
    setEscBusy(true);
    setEscError(null);
    try {
      const updated = escDialog === "question" ? await dismissQuestion(id) : await abortChat(id);
      if (updated) setSession(updated);
      else await fetchSessionData();
      setEscDialog(null);
    } catch (err) {
      setEscError(`${t.uxActionFailed} ${err instanceof Error ? err.message : ""}`.trim());
    } finally {
      setEscBusy(false);
    }
  };

  useShortcut(
    "find",
    () => {
      setFindOpen(true);
      setFindSignal((n) => n + 1);
    },
    Boolean(session),
  );

  // Inline rename (F2 / click): PUT /api/chats/{id}; the sidebar refreshes via SSE.
  const handleRename = async (title: string) => {
    if (!id) return;
    const updated = await renameChat(id, title);
    if (updated) setSession(updated);
    else await fetchSessionData();
  };

  // Handle navigate to memory retrieval drawing
  const handleOpenDrawing = async () => {
    if (!session) return;
    setIsCreatingDrawing(true);
    try {
      const drawing = await createDrawing({
        title: session.title || session.topic,
        session_id: session.id,
        prompt: t.drawLessonPrompt(session.title),
      });
      router.push(`/draw/${drawing.slug}`);
    } catch (err: any) {
      console.error("Failed to create drawing:", err);
      // Fallback slug
      const slug = (session.title || "retrieval")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
      router.push(`/draw/${slug}`);
    } finally {
      setIsCreatingDrawing(false);
    }
  };

  // Compute context badge
  const renderContextBadge = () => {
    if (!session) return null;

    if (session.mode === "PRACTICE") {
      const counts = practiceCounts(session.practice);
      return (
        <>
          <span className="px-2 py-0.5 rounded bg-accent border border-border font-ui text-[10.5px] text-foreground tracking-wide uppercase font-semibold">
            {t.practiceChip}
          </span>
          <span
            className="px-2 py-0.5 rounded border border-border font-ui text-[10.5px] text-muted-foreground tabular-nums"
            title={t.practiceCounterTitle}
          >
            {t.practiceCounter(counts.solved, counts.total)}
          </span>
        </>
      );
    }

    if (
      session.teach_context === "dense_source" ||
      session.source_file
    ) {
      return (
        <span className="px-2 py-0.5 rounded bg-accent border border-border font-ui text-[10.5px] text-foreground tracking-wide uppercase font-semibold flex items-center gap-1">
          <FileText className="w-3 h-3 text-warning" />
          {t.badgeDense}
        </span>
      );
    }

    if (
      session.teach_context === "track_step" ||
      session.track_item_id
    ) {
      return (
        <span className="px-2 py-0.5 rounded bg-accent border border-border font-ui text-[10.5px] text-foreground tracking-wide uppercase font-semibold flex items-center gap-1">
          <Compass className="w-3 h-3 text-warning" />
          {t.badgeTrack}
        </span>
      );
    }

    return (
      <span className="px-2 py-0.5 rounded bg-accent border border-border font-ui text-[10.5px] text-muted-foreground tracking-wide uppercase font-semibold">
        {t.badgeFree}
      </span>
    );
  };

  // Rebuilt only when a fetch replaces the session, not on every keystroke.
  const transcript = useMemo(() => (session ? buildTranscript(session) : []), [session]);

  // Safe Vault file name link
  const vaultNoteName = session
    ? session.title.replace(/[\/\\:*?"<>|]/g, "_")
    : "";

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] gap-3 text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin text-foreground" />
        <span className="font-ui text-xs tracking-wider">
          {t.sessionLoading}
        </span>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] gap-4 p-6 text-center">
        <p className="text-danger font-ui text-sm">{error || t.sessionNotFound}</p>
        <Link
          href="/"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-card hover:bg-accent border border-border text-xs font-ui text-foreground"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>{t.backHome}</span>
        </Link>
      </div>
    );
  }

  const isWaitingQuiz = Boolean(session.pending_quiz);
  const teachPhase =
    session.mode === "TEACH" ? normalizePhase(session.phase, Boolean(session.plan?.nodes.length)) : null;
  const execStatus = session.execution_status;
  const needsRecovery =
    session.recovery_required || execStatus === "failed" || execStatus === "interrupted";
  const engineErrorCard = showsEngineErrorCard(session) && !session.recovery_required;
  const levelingProgress =
    isLevelingSession(session) && !session.leveling ? decodeLevelingProgress(session.leveling_progress) : null;
  const isTeaching = execStatus === "queued" || execStatus === "running";
  const isRunning = isRunningStatus(execStatus);
  const compactionAnchor = compactionAnchorId(session.messages, session.compaction);
  const pendingSteers = visibleLocalSteers(localSteers, session.messages);
  const findVersion = `${session.updated_at}|${session.messages.length}|${execStatus}|${pendingSteers.length}`;
  const renderLocalSteers = () =>
    pendingSteers.map((steer) => (
      <LocalSteerBubble
        key={steer.localId}
        steer={steer}
        onDiscard={() => dispatchSteer({ type: "discard", localId: steer.localId })}
        onRetry={() => void sendSteer(steer.content, steer.localId)}
      />
    ));
  const isPractice = session.mode === "PRACTICE";
  const practiceItems = isPractice
    ? buildPracticeTranscript({
        messages: session.messages,
        practice: session.practice,
        answers: session.answers,
        pending_quiz: session.pending_quiz,
      })
    : [];
  const practiceActive = isPractice ? activeProblem(session.practice) : null;
  const practiceDock = dockState({
    activeProblemId: practiceActive?.id ?? null,
    executionStatus: execStatus,
    sending: isSending,
    pendingQuiz: isWaitingQuiz,
  });

  const renderMessage = (message: SessionRecord["messages"][number], key: string): React.ReactNode => {
    if (session.compaction && message.id === compactionAnchor) {
      return (
        <React.Fragment key={key}>
          <CompactionDivider compaction={session.compaction} />
          {renderBubble(message, `${key}-msg`)}
        </React.Fragment>
      );
    }
    return renderBubble(message, key);
  };

  const renderTeachItem = (item: ReturnType<typeof buildTranscript>[number]): React.ReactNode => {
    if (item.type === "divider") return <PhaseDivider key={item.key} phase={item.phase} />;
    if (item.type === "probe_done") return <ProbeDoneCard key={item.key} assessment={item.assessment} />;
    if (item.type === "leveling_done") {
      return <LevelingDoneCard key={item.key} leveling={item.leveling} sessionId={session.id} />;
    }
    if (item.type === "answer") return <AnsweredQuestionCard key={item.key} answer={item.answer} />;
    if (item.type === "job") return <JobCard key={item.key} job={item.job} message={item.message} />;
    if (item.type === "pending") {
      return (
        <QuestionDock
          key={item.key}
          quiz={item.quiz}
          sessionId={session.id}
          onAnswerSubmitted={() => {
            void fetchSessionData();
          }}
        />
      );
    }
    return renderMessage(item.message, item.key);
  };

  const renderBubble = (message: SessionRecord["messages"][number], key: string) => {
    if (message.role === "user") {
      return (
        <div key={key} id={`message-${message.id}`} className="flex justify-end my-2 scroll-mt-24">
          <div className="max-w-[85%] rounded-lg bg-card border border-border p-3.5 text-foreground font-prose text-[15.5px] leading-relaxed shadow-sm whitespace-pre-wrap">
            <span className="font-ui text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">
              {t.you}
              <LearnerSteerBadge message={message} />
            </span>
            {message.content}
          </div>
        </div>
      );
    }

    // Assistant message: Render editorial whiteboard prose with KaTeX and Citations
    return (
      <div key={key} id={`message-${message.id}`} className="my-3 flex flex-col gap-2 scroll-mt-24">
        <div className="flex items-center justify-between text-[11px] font-ui text-muted-foreground border-b border-accent pb-1 select-none">
          <span className="tracking-wider uppercase font-semibold">
            {t.teacherHarness}
          </span>
        </div>

        <LessonProse
          content={message.content}
          sourceName={session.source_file || session.title}
          onSelectCitation={handleOpenCitation}
        />
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background relative">
      {/* 1. Top Classroom Bar */}
      <header className="px-5 py-3 border-b border-border bg-background shrink-0 flex flex-wrap items-center justify-between gap-3 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <NavDrawerButton />
          <Link
            href="/"
            className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-card"
            title={t.backHome}
            aria-label={t.backHome}
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>

          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <SessionTitle
                title={session.title || session.topic}
                onRename={handleRename}
                onEditingChange={setRenaming}
              />
              {renderContextBadge()}
              {teachPhase && isLevelingSession(session) ? (
                <LevelingPhaseChip completed={teachPhase === "completed"} />
              ) : (
                teachPhase && <PhaseChip phase={teachPhase} />
              )}
            </div>

            <div className="flex items-center gap-2 text-[11px] font-ui text-muted-foreground mt-0.5 max-sm:hidden">
              <span>{t.vaultLabel} <code>{t.lessonsFolder}/{vaultNoteName}.md</code></span>
              {session.source_file && (
                <>
                  <span>·</span>
                  <span className="truncate">{t.sourceLabel} <code>{t.sourcesFolder}/{session.source_file}</code></span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Model chip + session usage, then Simulador Interativo & Desenhar de Memória */}
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker
            engine={activeSlot?.engine ?? strongSlot?.engine ?? "agy"}
            value={modelValue}
            defaultModel={strongSlot?.model}
            placement="down"
            busy={modelBusy}
            disabled={modelBusy}
            onChange={(next) => void handleModelChange(next)}
          />
          {session.usage && session.usage.total_tokens > 0 && (
            <span
              className="font-ui text-[11px] text-muted-foreground px-2 py-1 rounded-md border border-accent"
              title={t.usageBreakdown(
                formatTokens(session.usage.input_tokens, locale),
                formatTokens(session.usage.output_tokens, locale),
                formatTokens(session.usage.thinking_tokens, locale),
              )}
            >
              {t.sessionUsage(formatTokens(session.usage.total_tokens, locale), session.usage.turns)}
            </span>
          )}
          {!isPractice && (
          <>
          <button
            type="button"
            onClick={() => void handleExtract()}
            disabled={extracting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-card hover:bg-accent border border-border hover:border-muted-foreground text-foreground text-[11.5px] font-ui font-semibold transition-all cursor-pointer shadow-sm active:scale-95 disabled:cursor-not-allowed"
            title={t.extractGraphTitle}
          >
            {extracting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
            )}
            <span className="max-sm:sr-only">{t.extractGraph}</span>
          </button>

          <button
            type="button"
            onClick={handleSpawnDemo}
            disabled={isSpawningDemo}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-card hover:bg-accent border border-border hover:border-muted-foreground text-foreground text-[11.5px] font-ui font-semibold transition-all cursor-pointer shadow-sm active:scale-95"
            title={t.demoButtonTitle}
          >
            {isSpawningDemo ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-success" />
            )}
            <span className="max-sm:sr-only">{isSpawningDemo ? t.demoGenerating : t.demoButton}</span>
          </button>

          <button
            type="button"
            onClick={handleOpenDrawing}
            disabled={isCreatingDrawing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-card hover:bg-accent border border-border hover:border-muted-foreground text-foreground text-[11.5px] font-ui font-semibold transition-all cursor-pointer shadow-sm active:scale-95"
            title={t.drawFromMemoryTitle}
          >
            {isCreatingDrawing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Edit3 className="w-3.5 h-3.5 text-warning" />
            )}
            <span className="max-sm:sr-only">{t.drawFromMemory}</span>
          </button>
          </>
          )}
        </div>
        {extractNotice && (
          <p role="status" aria-live="polite" className="basis-full font-ui text-[11px] text-success">
            {extractNotice}
          </p>
        )}
      </header>

      {/* ⌘F find bar, floating over the top of the transcript */}
      <div className="relative shrink-0 z-30">
        {findOpen && (
          <SessionFindBar
            containerRef={transcriptRef}
            version={findVersion}
            focusSignal={findSignal}
            onClose={() => setFindOpen(false)}
          />
        )}
      </div>

      {/* 2. Main Lesson Prose Stream (TEACH and PRACTICE share the prose rendering) */}
      <div ref={transcriptRef} className="flex-1 overflow-y-auto px-4 sm:px-8 md:px-16 lg:px-24 py-6 max-w-4xl mx-auto w-full flex flex-col gap-6">
        {isPractice ? (
          <PracticeTranscript
            items={practiceItems}
            sessionId={session.id}
            activeProblemId={practiceActive?.id ?? null}
            nodeNames={nodeNames}
            onAnswerSubmitted={() => void fetchSessionData()}
            renderMessage={renderMessage}
          />
        ) : (
        <>
        {showDemo && demoSlug && (
          <DemoIframe
            key={demoSlug}
            title={`Simulador: ${session.title || session.topic}`}
            slug={demoSlug}
            showCloseButton
            onClose={() => setShowDemo(false)}
          />
        )}
        {levelingProgress && !levelingProgress.done && <LevelingProgressBand progress={levelingProgress} />}
        {transcript.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground font-prose text-base">
            {t.lessonStarting}
          </div>
        ) : (
          transcript.map((item) => {
            if (item.type !== "message" && item.key === compactionAnchor && session.compaction) {
              return (
                <React.Fragment key={`compaction-${item.key}`}>
                  <CompactionDivider compaction={session.compaction} />
                  {renderTeachItem(item)}
                </React.Fragment>
              );
            }
            return renderTeachItem(item);
          })
        )}
        {renderLocalSteers()}
        </>
        )}
        {isPractice && renderLocalSteers()}
        {execStatus === "compacting" && <CompactingPlaceholder />}

        <div ref={messagesEndRef} />
      </div>

      {/* 4a. Run-state strip: recovery banner / teaching indicator / inline errors */}
      {(needsRecovery || isTeaching || actionError) && (
        <div className="px-4 pt-3 bg-background shrink-0 z-20">
          <div className="max-w-4xl mx-auto flex flex-col gap-2">
            {engineErrorCard && session.error && (
              <EngineErrorCard
                error={session.error}
                retrying={isResuming}
                onRetry={() => void handleResume(false)}
                onChangeModel={() => dispatchCommand(OPEN_MODEL_PICKER_EVENT)}
              />
            )}

            {needsRecovery && !engineErrorCard && (
              <div
                role="alert"
                className="flex flex-wrap items-start gap-3 p-3 rounded border border-danger/50 bg-card"
              >
                <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 flex flex-col gap-1">
                  <span className="font-ui text-[12.5px] text-foreground">
                    {session.recovery_required
                      ? t.sessionRecovery
                      : execStatus === "interrupted"
                      ? t.sessionInterrupted
                      : t.sessionFailed}
                  </span>
                  {session.error && (
                    <code className="font-ui text-[11px] text-muted-foreground break-words whitespace-pre-wrap">
                      {session.error}
                    </code>
                  )}
                  {session.error?.includes("mcp(harness/*)") && (
                    <Link href="/settings?tab=connectors" className="font-ui text-[11px] text-foreground underline underline-offset-2">
                      {t.agyPermOpenSettings}
                    </Link>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!session.recovery_required && (
                    <button
                      type="button"
                      onClick={() => void handleResume(false)}
                      disabled={isResuming}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent hover:bg-border border border-border text-foreground text-[11px] font-ui font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-muted-foreground"
                    >
                      {isResuming ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="w-3.5 h-3.5" />
                      )}
                      <span>{isResuming ? t.resuming : t.resume}</span>
                    </button>
                  )}
                  {session.recovery_required && (
                    <button
                      type="button"
                      onClick={() => void handleResume(true)}
                      disabled={isResuming}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent hover:bg-border border border-border text-foreground text-[11px] font-ui font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-muted-foreground"
                    >
                      {isResuming ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Compass className="w-3.5 h-3.5" />
                      )}
                      <span>{isResuming ? t.resuming : t.restartDiagnostic}</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {isTeaching && !needsRecovery && (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 font-ui text-[11px] text-muted-foreground"
              >
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>{execStatus === "queued" ? t.queued : isPractice ? t.practiceRunning : t.teaching}</span>
              </div>
            )}

            {actionError && (
              <div
                role="alert"
                className="flex items-start gap-2 font-ui text-[11px] text-danger"
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span className="flex-1 break-words">{actionError}</span>
                <button
                  type="button"
                  onClick={() => setActionError(null)}
                  className="text-muted-foreground hover:text-foreground underline cursor-pointer shrink-0"
                >
                  {t.dismiss}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4b. Bottom input: PracticeDock (PRACTICE) or the follow-up bar (TEACH) */}
      {isPractice ? (
        <PracticeDock
          state={practiceDock}
          pendingQuiz={isWaitingQuiz}
          steerable={isRunning && !isWaitingQuiz}
          onSubmit={handlePracticeSubmit}
          onRequestDismiss={() => {
            setDismissError(null);
            setDismissOpen(true);
          }}
        />
      ) : (
      <footer className="px-4 py-3 bg-background border-t border-border shrink-0 z-20">
        <form
          ref={followUpRef}
          onSubmit={handleSendMessage}
          className="max-w-4xl mx-auto flex items-center gap-2"
        >
          {dictation.supported && (
            <button
              type="button"
              onClick={dictation.toggle}
              className={`p-2.5 rounded border transition-colors cursor-pointer shrink-0 ${
                dictation.listening
                  ? "bg-danger/10 text-danger border-danger animate-pulse"
                  : "bg-card hover:bg-accent text-muted-foreground hover:text-foreground border-border"
              }`}
              title={dictation.listening ? t.dictateStop : t.dictateMessage}
              aria-label={dictation.listening ? t.dictateStop : t.dictateMessage}
              aria-pressed={dictation.listening}
            >
              {dictation.listening ? (
                <MicOff className="w-4 h-4 text-danger" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </button>
          )}

          <div className="relative flex-1">
            <input
              type="text"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              placeholder={
                isWaitingQuiz
                  ? t.answerQuizFirst
                  : isRunning
                  ? t.uxSteerPlaceholder
                  : t.followUpPlaceholder
              }
              disabled={isSending}
              className="w-full bg-card border border-border rounded-lg px-4 py-2.5 text-sm font-prose text-foreground placeholder-muted-foreground focus:border-foreground transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={!inputMessage.trim() || isSending}
            className={`p-2.5 rounded-lg border font-ui text-xs uppercase tracking-wider font-semibold transition-all cursor-pointer shrink-0 ${
              !inputMessage.trim() || isSending
                ? "bg-card border-accent text-muted-foreground cursor-not-allowed"
                : "bg-accent hover:bg-border border-border text-foreground active:scale-95"
            }`}
            title={t.sendMessage}
            aria-label={t.sendMessage}
          >
            {isSending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </form>
      </footer>
      )}

      <ConfirmDialog
        open={escDialog !== null}
        title={escDialog === "question" ? t.uxEscQuestionTitle : t.uxEscAbortTitle}
        body={escDialog === "question" ? t.uxEscQuestionBody : t.uxEscAbortBody}
        confirmLabel={escDialog === "question" ? t.uxEscQuestionConfirm : t.uxEscAbortConfirm}
        busyLabel={escDialog === "question" ? t.uxEscQuestionBusy : t.uxEscAbortBusy}
        busy={escBusy}
        error={escError}
        danger={escDialog === "abort"}
        onCancel={() => setEscDialog(null)}
        onConfirm={() => void handleConfirmEsc()}
      />

      <DismissProblemDialog
        open={dismissOpen && Boolean(practiceActive)}
        busy={dismissBusy}
        error={dismissError}
        onCancel={() => setDismissOpen(false)}
        onConfirm={() => void handleConfirmDismiss()}
      />

      {/* 5. Floating PlanWindow Mini-DAG */}
      {session.plan && (
        <PlanWindow
          plan={session.plan}
          sourceName={session.source_file || session.title}
          onSelectCitation={handleOpenCitation}
        />
      )}

      {/* 6. Slide-Over Source Citation Drawer */}
      <SourceCitationPane
        isOpen={citationDrawerOpen}
        onClose={() => setCitationDrawerOpen(false)}
        sourceName={selectedSource}
        paragraphId={selectedParagraph}
      />
    </div>
  );
}
