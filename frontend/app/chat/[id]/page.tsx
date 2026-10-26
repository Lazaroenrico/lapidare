"use client";

import { useLocale } from "@/components/locale-provider";
import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Compass,
  Edit3,
  ExternalLink,
  FileText,
  Layers,
  Loader2,
  Mic,
  MicOff,
  RotateCcw,
  Send,
  Sparkles,
} from "lucide-react";
import type { CalibrationResult, SessionRecord } from "@/lib/types";
import {
  createDemo,
  createDrawing,
  getBackgroundJobs,
  getChat,
  resumeChat,
  sendChatMessage,
} from "@/lib/api";
import { useEventSubscription } from "@/components/server-events";
import { LessonProse } from "@/components/lesson-prose";
import { QuestionDock } from "@/components/question-dock";
import { PlanWindow } from "@/components/plan-window";
import { SourceCitationPane } from "@/components/source-citation-pane";
import { PracticeView } from "@/components/practice-view";
import { DemoIframe } from "@/components/demo-iframe";

interface ChatPageProps {
  params: Promise<{ id: string }>;
}

export default function ChatPage({ params }: ChatPageProps) {
  const {locale, t} = useLocale();
  const { id } = React.use(params);
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

  // Speech recognition dictation for bottom composer
  const [isListening, setIsListening] = useState<boolean>(false);
  const [speechSupported, setSpeechSupported] = useState<boolean>(false);

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

  // Speech support check
  useEffect(() => {
    if (typeof window !== "undefined") {
      const hasSpeech =
        "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
      setSpeechSupported(hasSpeech);
    }
  }, []);

  // Fetch session data (notify -> fetch pattern)
  const fetchSessionData = async () => {
    if (!id) return;
    try {
      const data = await getChat(id);
      setSession(data);
      setError(null);
    } catch (err: any) {
      console.error("Failed to fetch session:", err);
      setError(err?.message || "Sessão não encontrada.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchSessionData();
  }, [id]);

  // Subscribe to SSE events for real-time reactivity without polling
  useEventSubscription(
    ["session:updated", "dock:opened", "dock:resolved", "plan:updated"],
    () => {
      void fetchSessionData();
    }
  );

  // Scroll to bottom on message update
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [session?.messages, session?.pending_quiz]);

  // Handle open citation drawer
  const handleOpenCitation = (sourceName: string, paragraphId: string) => {
    setSelectedSource(sourceName);
    setSelectedParagraph(paragraphId);
    setCitationDrawerOpen(true);
  };

  // Toggle dictation
  const handleToggleDictation = () => {
    if (typeof window === "undefined") return;

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Reconhecimento de voz não suportado neste navegador.");
      return;
    }

    if (isListening) {
      setIsListening(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = locale === "en" ? "en-US" : "pt-BR";
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListening(true);
      };

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInputMessage((prev) =>
          prev ? `${prev} ${transcript}` : transcript
        );
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.start();
    } catch {
      setIsListening(false);
    }
  };

  // Handle send message
  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputMessage.trim() || isSending || !id) return;

    const textToSend = inputMessage.trim();
    setInputMessage("");
    setIsSending(true);
    setActionError(null);

    try {
      const res = await sendChatMessage(id, textToSend);
      if (res?.session) {
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

  // Handle navigate to memory retrieval drawing
  const handleOpenDrawing = async () => {
    if (!session) return;
    setIsCreatingDrawing(true);
    try {
      const drawing = await createDrawing({
        title: session.title || session.topic,
        session_id: session.id,
        prompt: `Desenhe de memória a arquitetura, equações e fluxo lógico aprendido na aula: ${session.title}`,
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
      return (
        <span className="px-2 py-0.5 rounded bg-[#2a2a2a] border border-[#434343] font-ui text-[10.5px] text-[#e6e6e6] tracking-wide uppercase font-semibold">
          ◇ PRACTICE · Hint Ladder R0–R5
        </span>
      );
    }

    if (
      session.teach_context === "dense_source" ||
      session.source_file
    ) {
      return (
        <span className="px-2 py-0.5 rounded bg-[#2a2a2a] border border-[#434343] font-ui text-[10.5px] text-[#e6e6e6] tracking-wide uppercase font-semibold flex items-center gap-1">
          <FileText className="w-3 h-3 text-[#e0a030]" />
          TEACH · Fonte Densa
        </span>
      );
    }

    if (
      session.teach_context === "track_step" ||
      session.track_item_id
    ) {
      return (
        <span className="px-2 py-0.5 rounded bg-[#2a2a2a] border border-[#434343] font-ui text-[10.5px] text-[#e6e6e6] tracking-wide uppercase font-semibold flex items-center gap-1">
          <Compass className="w-3 h-3 text-[#e0a030]" />
          TEACH · Trilha 2:1
        </span>
      );
    }

    return (
      <span className="px-2 py-0.5 rounded bg-[#2a2a2a] border border-[#434343] font-ui text-[10.5px] text-[#8d8d8d] tracking-wide uppercase font-semibold">
        TEACH · Tópico Livre
      </span>
    );
  };

  // Safe Vault file name link
  const vaultNoteName = session
    ? session.title.replace(/[\/\\:*?"<>|]/g, "_")
    : "";

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] gap-3 text-[#8d8d8d]">
        <Loader2 className="w-6 h-6 animate-spin text-[#e6e6e6]" />
        <span className="font-ui text-xs tracking-wider">
          Carregando Sessão da Sala de Aula...
        </span>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] gap-4 p-6 text-center">
        <p className="text-red-400 font-ui text-sm">{error || "Sessão não encontrada"}</p>
        <Link
          href="/"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1c1c1c] hover:bg-[#2a2a2a] border border-[#434343] text-xs font-ui text-[#e6e6e6]"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Voltar para a Home</span>
        </Link>
      </div>
    );
  }

  const isWaitingQuiz = session.status === "waiting_quiz" && session.pending_quiz;
  const execStatus = session.execution_status;
  const needsRecovery =
    session.recovery_required || execStatus === "failed" || execStatus === "interrupted";
  const isTeaching = execStatus === "queued" || execStatus === "running";

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#141414] relative">
      {/* 1. Top Classroom Bar */}
      <header className="px-5 py-3 border-b border-[#434343] bg-[#141414] shrink-0 flex flex-wrap items-center justify-between gap-3 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/"
            className="p-1 text-[#8d8d8d] hover:text-[#e6e6e6] transition-colors rounded hover:bg-[#1c1c1c]"
            title="Voltar para a Home"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>

          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-title font-bold text-lg md:text-xl text-[#e6e6e6] truncate">
                {session.title || session.topic}
              </h1>
              {renderContextBadge()}
            </div>

            <div className="flex items-center gap-2 text-[11px] font-ui text-[#8d8d8d] mt-0.5">
              <span>Vault: <code>Aulas/{vaultNoteName}.md</code></span>
              {session.source_file && (
                <>
                  <span>·</span>
                  <span className="truncate">Fonte: <code>Fontes/{session.source_file}</code></span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons: Simulador Interativo & Desenhar de Memória */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSpawnDemo}
            disabled={isSpawningDemo}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1c1c1c] hover:bg-[#2a2a2a] border border-[#434343] hover:border-[#8d8d8d] text-[#e6e6e6] text-[11.5px] font-ui font-semibold transition-all cursor-pointer shadow-sm active:scale-95"
            title="Gerar simulador interativo HTML5/Canvas em viz/demos/"
          >
            {isSpawningDemo ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-[#34d399]" />
            )}
            <span>{isSpawningDemo ? "gerando simulador…" : "⚡ Simulador"}</span>
          </button>

          <button
            type="button"
            onClick={handleOpenDrawing}
            disabled={isCreatingDrawing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1c1c1c] hover:bg-[#2a2a2a] border border-[#434343] hover:border-[#8d8d8d] text-[#e6e6e6] text-[11.5px] font-ui font-semibold transition-all cursor-pointer shadow-sm active:scale-95"
            title="Criar folha em branco de desenho de memória no Excalidraw"
          >
            {isCreatingDrawing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Edit3 className="w-3.5 h-3.5 text-[#e0a030]" />
            )}
            <span>✎ Desenhar de Memória</span>
          </button>
        </div>
      </header>

      {/* 2. Main Lesson Prose Stream or Practice View */}
      {session.mode === "PRACTICE" ? (
        <div className="flex-1 overflow-y-auto">
          <PracticeView onSelectCitation={handleOpenCitation} />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-4 sm:px-8 md:px-16 lg:px-24 py-6 max-w-4xl mx-auto w-full flex flex-col gap-6">
        {showDemo && demoSlug && (
          <DemoIframe
            key={demoSlug}
            title={`Simulador: ${session.title || session.topic}`}
            slug={demoSlug}
            showCloseButton
            onClose={() => setShowDemo(false)}
          />
        )}
        {session.messages.length === 0 ? (
          <div className="py-16 text-center text-[#8d8d8d] font-prose text-base">
            Iniciando aula... O professor está estruturando a explicação.
          </div>
        ) : (
          session.messages.map((message) => {
            const isUser = message.role === "user";

            if (isUser) {
              return (
                <div
                  key={message.id}
                  className="flex justify-end my-2"
                >
                  <div className="max-w-[85%] rounded-lg bg-[#222222] border border-[#434343] p-3.5 text-[#e6e6e6] font-prose text-[15.5px] leading-relaxed shadow-sm">
                    <span className="font-ui text-[10px] text-[#8d8d8d] uppercase tracking-wider block mb-1">
                      Você
                    </span>
                    {message.content}
                  </div>
                </div>
              );
            }

            // Assistant message: Render editorial whiteboard prose with KaTeX and Citations
            return (
              <div
                key={message.id}
                className="my-3 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between text-[11px] font-ui text-[#8d8d8d] border-b border-[#222222] pb-1 select-none">
                  <span className="tracking-wider uppercase font-semibold">
                    PROFESSOR HARNESS
                  </span>
                  {message.phase && (
                    <span className="capitalize text-[10px] px-1.5 py-0.2 bg-[#1c1c1c] border border-[#2a2a2a] rounded">
                      Fase: {message.phase}
                    </span>
                  )}
                </div>

                <LessonProse
                  content={message.content}
                  sourceName={session.source_file || session.title}
                  onSelectCitation={handleOpenCitation}
                />
              </div>
            );
          })
        )}

        {/* 3. QuestionDock (If there is a pending quiz) */}
        {session.pending_quiz && (
          <div className="my-4">
            <QuestionDock
              quiz={session.pending_quiz}
              sessionId={session.id}
              onAnswerSubmitted={(result) => {
                void fetchSessionData();
              }}
            />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>
      )}

      {/* 4a. Run-state strip: recovery banner / teaching indicator / inline errors */}
      {(needsRecovery || isTeaching || actionError) && (
        <div className="px-4 pt-3 bg-[#141414] shrink-0 z-20">
          <div className="max-w-4xl mx-auto flex flex-col gap-2">
            {needsRecovery && (
              <div
                role="alert"
                className="flex flex-wrap items-start gap-3 p-3 rounded border border-[#f87171]/50 bg-[#1c1c1c]"
              >
                <AlertTriangle className="w-4 h-4 text-[#f87171] shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 flex flex-col gap-1">
                  <span className="font-ui text-[12.5px] text-[#e6e6e6]">
                    {session.recovery_required
                      ? t.sessionRecovery
                      : execStatus === "interrupted"
                      ? t.sessionInterrupted
                      : t.sessionFailed}
                  </span>
                  {session.error && (
                    <code className="font-ui text-[11px] text-[#8d8d8d] break-words whitespace-pre-wrap">
                      {session.error}
                    </code>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!session.recovery_required && (
                    <button
                      type="button"
                      onClick={() => void handleResume(false)}
                      disabled={isResuming}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#2a2a2a] hover:bg-[#434343] border border-[#434343] text-[#e6e6e6] text-[11px] font-ui font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-[#8d8d8d]"
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
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#2a2a2a] hover:bg-[#434343] border border-[#434343] text-[#e6e6e6] text-[11px] font-ui font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-[#8d8d8d]"
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
                className="flex items-center gap-2 font-ui text-[11px] text-[#8d8d8d]"
              >
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>{execStatus === "queued" ? t.queued : t.teaching}</span>
              </div>
            )}

            {actionError && (
              <div
                role="alert"
                className="flex items-start gap-2 font-ui text-[11px] text-[#f87171]"
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span className="flex-1 break-words">{actionError}</span>
                <button
                  type="button"
                  onClick={() => setActionError(null)}
                  className="text-[#8d8d8d] hover:text-[#e6e6e6] underline cursor-pointer shrink-0"
                >
                  {t.dismiss}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4b. Bottom Follow-up Input Bar */}
      <footer className="px-4 py-3 bg-[#141414] border-t border-[#434343] shrink-0 z-20">
        <form
          onSubmit={handleSendMessage}
          className="max-w-4xl mx-auto flex items-center gap-2"
        >
          {speechSupported && (
            <button
              type="button"
              onClick={handleToggleDictation}
              className={`p-2.5 rounded border transition-colors cursor-pointer shrink-0 ${
                isListening
                  ? "bg-red-950/40 text-red-300 border-red-500 animate-pulse"
                  : "bg-[#1c1c1c] hover:bg-[#2a2a2a] text-[#8d8d8d] hover:text-[#e6e6e6] border-[#434343]"
              }`}
              title="Ditar mensagem por voz"
            >
              {isListening ? (
                <MicOff className="w-4 h-4 text-red-400" />
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
                  ? "Responda ao quiz acima no QuestionDock para avançar a aula..."
                  : "Pergunte, peça um exemplo alternativo ou aprofunde a teoria..."
              }
              disabled={isSending}
              className="w-full bg-[#1c1c1c] border border-[#434343] rounded-lg px-4 py-2.5 text-sm font-prose text-[#e6e6e6] placeholder-[#8d8d8d] focus:border-[#e6e6e6] transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={!inputMessage.trim() || isSending}
            className={`p-2.5 rounded-lg border font-ui text-xs uppercase tracking-wider font-semibold transition-all cursor-pointer shrink-0 ${
              !inputMessage.trim() || isSending
                ? "bg-[#1c1c1c] border-[#2a2a2a] text-[#8d8d8d] cursor-not-allowed"
                : "bg-[#2a2a2a] hover:bg-[#383838] border-[#434343] text-white active:scale-95"
            }`}
            title="Enviar mensagem"
          >
            {isSending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </form>
      </footer>

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
