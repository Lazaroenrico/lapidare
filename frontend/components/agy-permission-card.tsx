"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useLocale } from "@/components/locale-provider";
import { getAgyPermission, grantAgyPermission } from "@/lib/api";
import type { AgyPermissionStatus } from "@/lib/types";

/**
 * Status + consentimento da regra global `mcp(harness/*)` do agy.
 * Sem polling: busca ao montar e depois de conceder.
 */
export function AgyPermissionCard({ className = "" }: { className?: string }) {
  const { t } = useLocale();
  const [status, setStatus] = useState<AgyPermissionStatus | null>(null);
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getAgyPermission();
      setStatus(s);
      setError(s.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.requestFailed);
    }
  }, [t.requestFailed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const grant = async () => {
    setGranting(true);
    setError(null);
    try {
      const s = await grantAgyPermission();
      setStatus(s);
      setError(s.error);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.requestFailed);
    } finally {
      setGranting(false);
    }
  };

  if (status?.granted) {
    return (
      <p className={`flex items-center gap-1.5 font-ui text-[11px] text-success ${className}`}>
        <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
        <span>{t.agyPermGranted(status.rule)}</span>
      </p>
    );
  }

  if (!status && !error) {
    return (
      <p className={`flex items-center gap-1.5 font-ui text-[11px] text-muted-foreground ${className}`}>
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>{t.loading}</span>
      </p>
    );
  }

  return (
    <div className={`p-3 bg-card border border-warning/50 rounded space-y-2 font-ui ${className}`}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-warning shrink-0" />
        <span className="text-xs font-semibold text-foreground">{t.agyPermTitle}</span>
        {status && <code className="text-[11px] text-muted-foreground">{status.rule}</code>}
      </div>
      <p className="text-[11px] text-muted-foreground">{t.agyPermMissing}</p>
      {status && (
        <ul className="text-[11px] text-muted-foreground space-y-1 list-disc pl-4">
          <li>
            {t.agyPermChange(status.settings_path)}
          </li>
          <li>{t.agyPermBackup}</li>
          <li>{t.agyPermScope}</li>
        </ul>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-danger break-words whitespace-pre-wrap">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void grant()}
        disabled={granting || !status}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-foreground text-background hover:opacity-90 text-[11px] font-semibold transition-opacity cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      >
        {granting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        <span>{granting ? t.agyPermGranting : t.agyPermButton}</span>
      </button>
    </div>
  );
}
