"use client";

import { useLocale } from "@/components/locale-provider";
import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Mic,
  MicOff,
  Send,
  Sparkles,
} from "lucide-react";
import type {
  CalibrationBand,
  CalibrationResult,
  QuizOption,
  QuizPayload,
  QuizSubmission,
} from "@/lib/types";
import { submitQuizAnswer } from "@/lib/api";

interface QuestionDockProps {
  quiz: QuizPayload;
  sessionId: string;
  onAnswerSubmitted?: (result: CalibrationResult) => void;
  initialResult?: CalibrationResult | null;
  className?: string;
}

export function QuestionDock({
  quiz,
  sessionId,
  onAnswerSubmitted,
  initialResult = null,
  className = "",
}: QuestionDockProps) {
  // Modes: PREDICTION starts open, CHECK starts collapsed as a compact pill
  const {locale, t} = useLocale();
  const [isExpanded, setIsExpanded] = useState<boolean>(() => {
    return quiz.mode === "PREDICTION" || initialResult !== null;
  });

  const [selectedChoice, setSelectedChoice] = useState<number | null>(() => {
    return initialResult ? initialResult.chosen_index : null;
  });
  const [confidence, setConfidence] = useState<number>(() => {
    return initialResult ? initialResult.confidence : 50;
  });
  const [learnerThinking, setLearnerThinking] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [result, setResult] = useState<CalibrationResult | null>(initialResult);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Dictation state (Web Speech API)
  const [isListening, setIsListening] = useState<boolean>(false);
  const [speechSupported, setSpeechSupported] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const hasSpeech =
        "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
      setSpeechSupported(hasSpeech);
    }
  }, []);

  // Update when initialResult changes from props
  useEffect(() => {
    if (initialResult) {
      setResult(initialResult);
      setSelectedChoice(initialResult.chosen_index);
      setConfidence(initialResult.confidence);
      setIsExpanded(true);
    }
  }, [initialResult]);

  // Confidence bands
  const getConfidenceBand = (val: number): { label: string; color: string } => {
    if (val < 50) {
      return { label: "Baixa (<50%)", color: "text-[#8d8d8d]" };
    }
    if (val < 70) {
      return { label: "Média (50–69%)", color: "text-[#e6e6e6]" };
    }
    return { label: "Alta (≥70%)", color: "text-[#e0a030]" };
  };

  const currentBand = getConfidenceBand(confidence);

  // Speech recognition dictation handler
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
        setLearnerThinking((prev) =>
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

  // Submission handler
  const handleSubmit = async () => {
    if (selectedChoice === null) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    const submission: QuizSubmission = {
      quiz_id: quiz.id,
      chosen_index: selectedChoice,
      confidence,
      learner_thinking: learnerThinking.trim() || undefined,
    };

    try {
      const res = await submitQuizAnswer(sessionId, submission);
      setResult(res);
      if (onAnswerSubmitted) {
        onAnswerSubmitted(res);
      }
    } catch (err: any) {
      console.error("Failed to submit quiz answer:", err);
      setErrorMsg(
        err?.message || "Erro ao enviar resposta. Tente novamente."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // Special index for "Não sei — me ensina / I don't know"
  const DONT_KNOW_INDEX = -1;

  // Render collapsed compact pill for CHECK mode
  if (!isExpanded && !result) {
    return (
      <div className={`my-4 ${className}`}>
        <button
          type="button"
          onClick={() => setIsExpanded(true)}
          className="w-full group flex items-center justify-between px-4 py-3 bg-[#1c1c1c] hover:bg-[#2a2a2a] border border-[#434343] hover:border-[#8d8d8d] rounded-lg cursor-pointer transition-all active:scale-[0.99] text-left shadow-md"
        >
          <div className="flex items-center gap-2.5">
            <span className="w-5 h-5 rounded-full bg-[#2a2a2a] group-hover:bg-[#434343] border border-[#434343] flex items-center justify-center text-[11px] text-[#e6e6e6] font-ui transition-colors">
              ✓
            </span>
            <div className="flex flex-col">
              <span className="text-[13px] font-semibold text-[#e6e6e6] font-ui tracking-wide group-hover:text-white">
                Check your understanding · Clique para abrir
              </span>
              <span className="text-[11px] text-[#8d8d8d] font-prose">
                Leia a explicação e formule sua resposta no seu próprio ritmo.
              </span>
            </div>
          </div>
          <ChevronDown className="w-4 h-4 text-[#8d8d8d] group-hover:text-[#e6e6e6] transition-colors" />
        </button>
      </div>
    );
  }

  // Render calibration feedback badge
  const renderCalibrationBadge = (band: CalibrationBand) => {
    switch (band) {
      case "calibrated":
        return (
          <div className="p-3 rounded-lg border border-green-600/60 bg-green-950/20 text-green-300 flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-ui text-[12px] font-bold tracking-wide">
                ✓ Calibrado (Acerto + ≥70%)
              </p>
              <p className="font-prose text-[13px] text-green-200/90 mt-0.5 leading-relaxed">
                Excelente calibração! Sua alta confiança estava alinhada com a resposta correta.
              </p>
            </div>
          </div>
        );
      case "illusion_of_competence":
        return (
          <div className="p-3.5 rounded-lg border-2 border-amber-500 bg-amber-950/40 text-amber-200 shadow-[0_0_20px_rgba(245,158,11,0.2)] flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0 animate-pulse" />
            <div>
              <p className="font-ui text-[12.5px] font-bold tracking-wide text-amber-300">
                ⚠ Ilusão de Competência (Erro + ≥70%)
              </p>
              <p className="font-prose text-[13.5px] text-amber-100 mt-1 leading-relaxed">
                Você tinha alta confiança, mas a premissa falhou. O agente usará seu raciocínio registrado abaixo para apresentar um contra-exemplo concreto e desatar esse nó.
              </p>
            </div>
          </div>
        );
      case "fragile_intuition":
        return (
          <div className="p-3 rounded-lg border border-blue-500/60 bg-blue-950/20 text-blue-200 flex items-start gap-2.5">
            <Sparkles className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-ui text-[12px] font-bold tracking-wide text-blue-300">
                ◇ Intuição Frágil (Acerto + &lt;50%)
              </p>
              <p className="font-prose text-[13px] text-blue-100 mt-0.5 leading-relaxed">
                Você acertou, mas com baixa certeza. Vamos solidificar a base teórica para transformar esse palpite em convicção sólida.
              </p>
            </div>
          </div>
        );
      case "conscious_gap":
        return (
          <div className="p-3 rounded-lg border border-purple-500/60 bg-purple-950/20 text-purple-200 flex items-start gap-2.5">
            <HelpCircle className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" />
            <div>
              <p className="font-ui text-[12px] font-bold tracking-wide text-purple-300">
                ✦ Lacuna Consciente (Erro + &lt;50% ou Não sei)
              </p>
              <p className="font-prose text-[13px] text-purple-100 mt-0.5 leading-relaxed">
                Reconhecer onde falta base é a virtude máxima do aprendizado ativo. O agente vai recuar um passo e construir a intuição do zero.
              </p>
            </div>
          </div>
        );
    }
  };

  return (
    <div
      className={`my-5 rounded-lg bg-[#1c1c1c] border transition-all duration-200 shadow-xl overflow-hidden ${
        result?.band === "illusion_of_competence"
          ? "border-amber-500/80 shadow-[0_0_24px_rgba(245,158,11,0.15)]"
          : "border-[#434343]"
      } ${className}`}
    >
      {/* Header bar */}
      <div className="px-4 py-2.5 bg-[#141414] border-b border-[#434343] flex items-center justify-between text-xs font-ui">
        <div className="flex items-center gap-2">
          {quiz.mode === "PREDICTION" ? (
            <span className="px-2 py-0.5 rounded bg-[#e0a030]/15 text-[#e0a030] border border-[#e0a030]/30 font-bold uppercase tracking-wider text-[10.5px]">
              ⚡ PREVISÃO · Antes do Próximo Passo
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded bg-[#2a2a2a] text-[#e6e6e6] border border-[#434343] font-bold uppercase tracking-wider text-[10.5px]">
              ✓ CHECAGEM DE ENTENDIMENTO
            </span>
          )}
          {quiz.target_concept && (
            <span className="text-[#8d8d8d] hidden sm:inline">
              · Alvo: [[{quiz.target_concept}]]
            </span>
          )}
        </div>

        {quiz.mode === "CHECK" && !result && (
          <button
            type="button"
            onClick={() => setIsExpanded(false)}
            className="text-[#8d8d8d] hover:text-[#e6e6e6] transition-colors p-1"
            title="Recolher para ler a prosa"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="p-5 flex flex-col gap-4">
        {/* Question Stem */}
        <div className="font-prose text-[16.5px] leading-relaxed text-[#e6e6e6] select-text">
          {quiz.question}
        </div>

        {/* Choices (2 to 6 options + fixed "Não sei — me ensina") */}
        <div className="flex flex-col gap-2">
          {quiz.options.map((option) => {
            const isSelected = selectedChoice === option.index;
            const isCorrect = result && result.correct_index === option.index;
            const isChosen = result && result.chosen_index === option.index;

            let optionStyle =
              "bg-[#141414] border-[#434343] text-[#e6e6e6] hover:bg-[#2a2a2a] hover:border-[#8d8d8d]";

            if (result) {
              if (isCorrect) {
                optionStyle =
                  "bg-green-950/30 border-green-500/80 text-green-200 font-semibold";
              } else if (isChosen && !isCorrect) {
                optionStyle =
                  "bg-red-950/30 border-red-500/80 text-red-200 line-through";
              } else {
                optionStyle = "bg-[#141414]/50 border-[#2a2a2a] text-[#8d8d8d]";
              }
            } else if (isSelected) {
              optionStyle =
                "bg-[#2a2a2a] border-[#e6e6e6] text-white shadow-sm";
            }

            return (
              <button
                key={option.index}
                type="button"
                disabled={result !== null || isSubmitting}
                onClick={() => setSelectedChoice(option.index)}
                className={`flex items-start gap-3 p-3 rounded border text-left cursor-pointer transition-all ${optionStyle} ${
                  result !== null ? "cursor-default" : ""
                }`}
              >
                <span className="w-5 h-5 rounded-full bg-[#1c1c1c] border border-[#434343] flex items-center justify-center text-[11px] font-ui text-[#8d8d8d] shrink-0 mt-0.5">
                  {option.label || String.fromCharCode(65 + option.index)}
                </span>
                <span className="font-prose text-[15px] leading-snug flex-1 select-text">
                  {option.text}
                </span>
                {result && isCorrect && (
                  <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                )}
              </button>
            );
          })}

          {/* Fixed final option: "Não sei — me ensina / I don't know" */}
          {quiz.has_dont_know !== false && (
            <button
              type="button"
              disabled={result !== null || isSubmitting}
              onClick={() => {
                setSelectedChoice(DONT_KNOW_INDEX);
                setConfidence(0);
              }}
              className={`flex items-center gap-3 p-2.5 rounded border text-left cursor-pointer transition-all ${
                selectedChoice === DONT_KNOW_INDEX
                  ? "bg-[#2a2a2a] border-purple-400 text-purple-200"
                  : "bg-[#141414] border-[#434343] text-[#8d8d8d] hover:text-[#e6e6e6] hover:bg-[#222222]"
              } ${result !== null ? "cursor-default" : ""}`}
            >
              <span className="w-5 h-5 rounded-full bg-[#1c1c1c] border border-[#434343] flex items-center justify-center text-[10.5px] font-ui text-[#8d8d8d] shrink-0">
                ?
              </span>
              <span className="font-ui text-[12.5px] tracking-wide">
                {t.dontKnow}
              </span>
            </button>
          )}
        </div>

        {/* Only show Confidence Slider and Thinking Input before submission */}
        {!result && (
          <div className="flex flex-col gap-4 pt-2 border-t border-[#2a2a2a]">
            {/* Confidence Slider: 0% to 100% */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs font-ui">
                <span className="text-[#8d8d8d] uppercase tracking-wider text-[11px]">
                  {t.confidence}
                </span>
                <span className={`font-bold ${currentBand.color}`}>
                  {confidence}% · {currentBand.label}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={confidence}
                onChange={(e) => setConfidence(Number(e.target.value))}
                className="w-full accent-[#e6e6e6] bg-[#2a2a2a] h-1.5 rounded cursor-pointer transition-all"
              />
              <div className="flex justify-between text-[10px] font-ui text-[#8d8d8d] px-0.5">
                <span>0% (Chute / Dúvida)</span>
                <span>50% (Média)</span>
                <span>100% (Certeza Absoluta)</span>
              </div>
            </div>

            {/* YOUR THINKING Input with Mic Dictation Button */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs font-ui">
                <label
                  htmlFor={`thinking-${quiz.id}`}
                  className="text-[#8d8d8d] uppercase tracking-wider text-[11px]"
                >
                  {t.thinking}
                </label>
                {speechSupported && (
                  <button
                    type="button"
                    onClick={handleToggleDictation}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-ui transition-colors cursor-pointer ${
                      isListening
                        ? "bg-red-950/40 text-red-300 border-red-500 animate-pulse"
                        : "bg-[#141414] text-[#8d8d8d] border-[#434343] hover:text-[#e6e6e6]"
                    }`}
                    title="Ditar raciocínio por voz"
                  >
                    {isListening ? (
                      <>
                        <MicOff className="w-3 h-3 text-red-400" />
                        <span>Ouvindo...</span>
                      </>
                    ) : (
                      <>
                        <Mic className="w-3 h-3" />
                        <span>🎙 Ditado</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              <div className="relative">
                <textarea
                  id={`thinking-${quiz.id}`}
                  rows={2}
                  value={learnerThinking}
                  onChange={(e) => setLearnerThinking(e.target.value)}
                  placeholder={t.thinkingPrompt}
                  className="w-full bg-[#141414] border border-[#434343] rounded p-2.5 text-[13px] font-prose text-[#e6e6e6] placeholder-[#8d8d8d] focus:border-[#e6e6e6] transition-colors resize-none leading-relaxed"
                />
              </div>
            </div>

            {errorMsg && (
              <p className="text-red-400 text-xs font-ui">{errorMsg}</p>
            )}

            {/* Submit Button */}
            <button
              type="button"
              disabled={selectedChoice === null || isSubmitting}
              onClick={handleSubmit}
              className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded border font-ui text-[12px] uppercase tracking-wider font-bold transition-all cursor-pointer ${
                selectedChoice === null || isSubmitting
                  ? "bg-[#141414] border-[#2a2a2a] text-[#8d8d8d] cursor-not-allowed"
                  : "bg-[#2a2a2a] hover:bg-[#383838] border-[#434343] text-white active:scale-[0.99] shadow-md"
              }`}
            >
              {isSubmitting ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-t-transparent border-white rounded-full animate-spin" />
                  <span>Avaliando Calibração...</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>Confirmar Resposta &amp; Calibrar</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Display Feedback Prose & Calibration Result after submission */}
        {result && (
          <div className="flex flex-col gap-3 pt-3 border-t border-[#2a2a2a]">
            {renderCalibrationBadge(result.band)}

            {result.feedback_prose && (
              <div className="p-3.5 rounded bg-[#141414] border border-[#2a2a2a] font-prose text-[14px] leading-relaxed text-[#e6e6e6] select-text">
                <span className="font-ui text-[10.5px] uppercase tracking-wider text-[#8d8d8d] block mb-1">
                  Análise Pedagógica:
                </span>
                {result.feedback_prose}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
