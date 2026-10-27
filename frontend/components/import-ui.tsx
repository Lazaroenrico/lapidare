"use client";

/**
 * Primitivas visuais compartilhadas pelo import multi-fonte e pelas Configurações.
 * Só tokens do Design System (background / card / accent / border / foreground / muted-foreground)
 * e os acentos semânticos já existentes (success / warning / danger).
 * Sem outline nativo: o foco aparece como mudança de borda/fundo.
 */

import React, { useEffect, useRef } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";

const BTN: Record<BtnVariant, string> = {
  primary:
    "bg-foreground text-background border-foreground font-semibold hover:bg-foreground/90 focus-visible:bg-foreground/90",
  secondary:
    "bg-accent text-foreground border-border hover:border-muted-foreground focus-visible:border-foreground",
  ghost:
    "bg-transparent text-muted-foreground border-transparent hover:text-foreground hover:bg-accent focus-visible:text-foreground focus-visible:bg-accent",
  danger:
    "bg-transparent text-danger border-border hover:border-danger focus-visible:border-danger",
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
  "w-full bg-background border border-border focus:border-muted-foreground rounded-md px-3 py-1 font-ui text-[12.5px] leading-6 text-foreground placeholder-muted-foreground";

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
      <label htmlFor={htmlFor} className="block font-ui text-[11px] text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="font-ui text-[11px] text-muted-foreground/80">{hint}</p>}
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
        className="mt-1 accent-foreground cursor-pointer"
      />
      <label htmlFor={id} className="font-ui text-[12.5px] text-foreground cursor-pointer">
        {label}
        {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
      </label>
    </div>
  );
}

type Tone = "error" | "warn" | "ok" | "info";
const TONE: Record<Tone, string> = {
  error: "border-danger/40 bg-danger/10 text-danger",
  warn: "border-warning/40 bg-warning/10 text-warning",
  ok: "border-success/40 bg-success/10 text-success",
  info: "border-border bg-background text-muted-foreground",
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
        tone === "new" && "border-success/40 bg-success/10 text-success",
        tone === "warn" && "border-warning/40 bg-warning/10 text-warning",
        tone === "muted" && "border-border bg-accent text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}

/** Barra indeterminada para operações longas (clone do GitHub). Sem timers. */
export function BusyStrip({ label, onCancel, cancelLabel }: { label: string; onCancel?: () => void; cancelLabel: string }) {
  return (
    <div role="status" aria-live="polite" className="rounded-md border border-border bg-background p-3 space-y-2">
      <div className="flex items-center gap-2 font-ui text-[11px] text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
        <span className="flex-1">{label}</span>
        {onCancel && (
          <Btn variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Btn>
        )}
      </div>
      <div className="h-1 rounded bg-accent overflow-hidden">
        <div className="h-full w-full bg-muted-foreground animate-pulse" />
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

/** Checkbox de pasta com estado indeterminado (alguns filhos marcados). */
export function FolderCheckbox({
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
