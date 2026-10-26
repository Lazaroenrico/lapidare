"use client";

/**
 * Primitivas visuais compartilhadas pelo import multi-fonte e pelas Configurações.
 * Só tokens do Design System (#141414 / #1c1c1c / #2a2a2a / #434343 / #e6e6e6 / #8d8d8d)
 * e os acentos semânticos já existentes (#34d399 / #e0a030 / #f87171).
 * Sem outline nativo: o foco aparece como mudança de borda/fundo.
 */

import React from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";

const BTN: Record<BtnVariant, string> = {
  primary:
    "bg-[#e6e6e6] text-[#141414] border-[#e6e6e6] font-semibold hover:bg-[#e6e6e6]/90 focus-visible:bg-[#e6e6e6]/90",
  secondary:
    "bg-[#2a2a2a] text-[#e6e6e6] border-[#434343] hover:border-[#8d8d8d] focus-visible:border-[#e6e6e6]",
  ghost:
    "bg-transparent text-[#8d8d8d] border-transparent hover:text-[#e6e6e6] hover:bg-[#2a2a2a] focus-visible:text-[#e6e6e6] focus-visible:bg-[#2a2a2a]",
  danger:
    "bg-transparent text-[#f87171] border-[#434343] hover:border-[#f87171] focus-visible:border-[#f87171]",
};

export function Btn({
  variant = "secondary",
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        "inline-flex items-center justify-center gap-2 px-3 py-1 rounded-md border font-ui text-[12.5px] leading-5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed",
        BTN[variant],
        className
      )}
    >
      {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export const inputClass =
  "w-full bg-[#141414] border border-[#434343] focus:border-[#8d8d8d] rounded-md px-3 py-1 font-ui text-[12.5px] leading-6 text-[#e6e6e6] placeholder-[#8d8d8d]";

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block font-ui text-[11px] text-[#8d8d8d]">
        {label}
      </label>
      {children}
      {hint && <p className="font-ui text-[11px] text-[#8d8d8d]/80">{hint}</p>}
    </div>
  );
}

export function Check({
  checked,
  onChange,
  label,
  hint,
  id,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  id: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 accent-[#e6e6e6] cursor-pointer"
      />
      <label htmlFor={id} className="font-ui text-[12.5px] text-[#e6e6e6] cursor-pointer">
        {label}
        {hint && <span className="block text-[11px] text-[#8d8d8d]">{hint}</span>}
      </label>
    </div>
  );
}

type Tone = "error" | "warn" | "ok" | "info";
const TONE: Record<Tone, string> = {
  error: "border-[#f87171]/40 bg-[#f87171]/10 text-[#f87171]",
  warn: "border-[#e0a030]/40 bg-[#e0a030]/10 text-[#e0a030]",
  ok: "border-[#34d399]/40 bg-[#34d399]/10 text-[#34d399]",
  info: "border-[#434343] bg-[#141414] text-[#8d8d8d]",
};

export function Banner({
  tone,
  children,
  action,
}: {
  tone: Tone;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const Icon = tone === "error" ? AlertCircle : tone === "ok" ? CheckCircle2 : AlertTriangle;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx("flex items-start gap-2 rounded-md border px-3 py-2 font-ui text-[11px] leading-5", TONE[tone])}
    >
      <Icon className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
      <div className="flex-1 min-w-0 break-words">{children}</div>
      {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
    </div>
  );
}

export function Badge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "new" | "warn" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center px-1 rounded border font-ui text-[10px] leading-4 tracking-wider shrink-0",
        tone === "new" && "border-[#34d399]/40 bg-[#34d399]/10 text-[#34d399]",
        tone === "warn" && "border-[#e0a030]/40 bg-[#e0a030]/10 text-[#e0a030]",
        tone === "muted" && "border-[#434343] bg-[#2a2a2a] text-[#8d8d8d]"
      )}
    >
      {children}
    </span>
  );
}

/** Barra indeterminada para operações longas (clone do GitHub). Sem timers. */
export function BusyStrip({ label, onCancel, cancelLabel }: { label: string; onCancel?: () => void; cancelLabel: string }) {
  return (
    <div role="status" aria-live="polite" className="rounded-md border border-[#434343] bg-[#141414] p-3 space-y-2">
      <div className="flex items-center gap-2 font-ui text-[11px] text-[#8d8d8d]">
        <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
        <span className="flex-1">{label}</span>
        {onCancel && (
          <Btn variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Btn>
        )}
      </div>
      <div className="h-1 rounded bg-[#2a2a2a] overflow-hidden">
        <div className="h-full w-full bg-[#8d8d8d] animate-pulse" />
      </div>
    </div>
  );
}

/** Setas ↑/↓ (e Home/End) movem o foco entre elementos `[data-nav]` dentro do contêiner. */
export function handleListKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-nav]"));
  if (items.length === 0) return;
  const idx = items.indexOf(document.activeElement as HTMLElement);
  let next = idx;
  if (e.key === "ArrowDown") next = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
  if (e.key === "ArrowUp") next = idx < 0 ? 0 : Math.max(0, idx - 1);
  if (e.key === "Home") next = 0;
  if (e.key === "End") next = items.length - 1;
  e.preventDefault();
  items[next]?.focus();
}

export const errMsg = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;
