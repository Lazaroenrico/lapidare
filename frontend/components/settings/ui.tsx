"use client";

import React from "react";

export function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h2 className="font-title text-base font-bold text-foreground">{title}</h2>
      {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`p-4 bg-card border border-border rounded space-y-3 ${className}`}>{children}</div>;
}

/** On/off switch (role="switch"), token colors only. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
        checked ? "bg-foreground border-foreground" : "bg-background border-border"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
          checked ? "translate-x-[18px] bg-background" : "translate-x-[2px] bg-muted-foreground"
        }`}
      />
    </button>
  );
}

export function InlineStatus({ status }: { status: { type: "success" | "error"; text: string } | null }) {
  if (!status) return null;
  return (
    <span role="status" className={`font-ui text-[11px] ${status.type === "success" ? "text-success" : "text-danger"}`}>
      {status.text}
    </span>
  );
}

export const buttonClass =
  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-border bg-accent hover:bg-border text-foreground font-ui text-[11px] cursor-pointer transition-colors disabled:cursor-not-allowed disabled:text-muted-foreground disabled:bg-background";
