"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { SetupDialog } from "@/components/setup-dialog";
import { useEventSubscription } from "@/components/server-events";
import { useLocale } from "@/components/locale-provider";
import { getSetupStatus } from "@/lib/api";

const DISMISSED_KEY = "learnharness:setup-dismissed";

/** Opens the Setup wizard from anywhere: on boot while the vault is not configured,
 * and whenever any request answers 409 "complete setup" (`harness:open-setup`). */
export function openSetup() {
  window.dispatchEvent(new CustomEvent("harness:open-setup"));
}

export function SetupGate() {
  const { t } = useLocale();
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = () =>
    getSetupStatus()
      .then((status) => setInitialized(status.initialized))
      .catch(() => setInitialized(null));

  useEffect(() => {
    getSetupStatus()
      .then((status) => {
        setInitialized(status.initialized);
        let dismissed = false;
        try {
          dismissed = sessionStorage.getItem(DISMISSED_KEY) === "1";
        } catch {
          /* storage unavailable: still open */
        }
        if (!status.initialized && !dismissed) setOpen(true);
      })
      .catch(() => setInitialized(null));
    const onOpen = () => setOpen(true);
    window.addEventListener("harness:open-setup", onOpen);
    return () => window.removeEventListener("harness:open-setup", onOpen);
  }, []);

  useEventSubscription(["config:updated"], () => void refresh());

  const close = () => {
    setOpen(false);
    try {
      sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      {initialized === false && !open && (
        <div className="fixed top-3 right-3 z-40 flex items-center gap-3 rounded border border-warning/40 bg-card px-3 py-2 font-ui text-[11px] text-foreground shadow-lg">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
          <span>{t.setupPending}</span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded border border-border bg-accent px-2 py-1 font-semibold hover:bg-border"
          >
            {t.setupPendingAction}
          </button>
        </div>
      )}
      <SetupDialog
        isOpen={open}
        onClose={close}
        onComplete={() => {
          setOpen(false);
          setInitialized(true);
        }}
      />
    </>
  );
}
