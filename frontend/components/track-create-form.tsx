"use client";

/**
 * "Nova trilha" form (Fase 14): tabs Objetivo ou ementa / Lista de tópicos /
 * Repositório local / GitHub. Controlled by the caller (Settings dialog, Setup
 * step); the GitHub URL uses the same validation as the import panel.
 */

import React, { useEffect, useRef, useState } from "react";
import { FolderGit2, GitBranch, ListOrdered, Target } from "lucide-react";
import { isAbortError, previewGithubRepo } from "@/lib/api";
import { isGithubRepoUrl } from "@/lib/import-wire";
import { GOAL_MAX, parseTopicList, type DraftError, type NewTrackDraft, type NewTrackTab } from "@/lib/tracks";
import { tracksText } from "@/lib/tracks-i18n";
import { useLocale } from "./locale-provider";
import { Btn, Check, Field, cx, errMsg, inputClass } from "./import-ui";

const TABS: { id: NewTrackTab; Icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "goal", Icon: Target },
  { id: "manual", Icon: ListOrdered },
  { id: "repo", Icon: FolderGit2 },
  { id: "github", Icon: GitBranch },
];

export function TrackCreateForm({
  draft,
  onChange,
  error,
  disabled = false,
  showActivate = true,
  idPrefix = "new-track",
}: {
  draft: NewTrackDraft;
  onChange: (next: NewTrackDraft) => void;
  error: DraftError | null;
  disabled?: boolean;
  showActivate?: boolean;
  idPrefix?: string;
}) {
  const { locale } = useLocale();
  const tt = tracksText(locale);
  const set = (patch: Partial<NewTrackDraft>) => onChange({ ...draft, ...patch });
  const id = (name: string) => `${idPrefix}-${name}`;

  // Optional GitHub check (same preview route as the import panel).
  const [ghCheck, setGhCheck] = useState<{ busy: boolean; ok: string | null; error: string | null }>({
    busy: false,
    ok: null,
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const validateGithub = async () => {
    if (!isGithubRepoUrl(draft.githubUrl)) {
      setGhCheck({ busy: false, ok: null, error: tt.errors.github });
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setGhCheck({ busy: true, ok: null, error: null });
    try {
      const preview = await previewGithubRepo(draft.githubUrl, ctrl.signal);
      setGhCheck({
        busy: false,
        ok: tt.validated(`${preview.repo.owner}/${preview.repo.name}`, preview.files.length),
        error: null,
      });
    } catch (err) {
      if (isAbortError(err)) return;
      setGhCheck({ busy: false, ok: null, error: errMsg(err, tt.errors.github) });
    }
  };

  const topicsCount = draft.tab === "manual" ? parseTopicList(draft.topics).length : 0;
  const titleOptional = draft.tab === "repo" || draft.tab === "github";
  const fieldError = (keys: DraftError[]) =>
    error && keys.includes(error) ? (
      <p role="alert" className="font-ui text-[11px] text-danger">
        {tt.errors[error]}
      </p>
    ) : null;

  return (
    <div className="space-y-3 font-ui">
      <div role="tablist" aria-label={tt.dialogTitle} className="grid grid-cols-2 sm:grid-cols-4 gap-1 bg-background p-1 rounded-md border border-border">
        {TABS.map(({ id: tab, Icon }) => {
          const active = draft.tab === tab;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={disabled}
              onClick={() => set({ tab })}
              className={cx(
                "flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] border transition-colors cursor-pointer",
                active
                  ? "bg-accent border-border text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground focus-visible:text-foreground",
              )}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{tt.tabs[tab]}</span>
            </button>
          );
        })}
      </div>

      <Field label={titleOptional ? tt.titleOptional : tt.title} htmlFor={id("title")}>
        <input
          id={id("title")}
          type="text"
          value={draft.title}
          disabled={disabled}
          maxLength={200}
          onChange={(e) => set({ title: e.target.value })}
          placeholder={tt.titlePh}
          className={inputClass}
        />
      </Field>
      {fieldError(["title"])}

      {draft.tab === "goal" && (
        <div className="space-y-1">
          <Field label={tt.goal} htmlFor={id("goal")}>
            <textarea
              id={id("goal")}
              value={draft.goal}
              disabled={disabled}
              onChange={(e) => set({ goal: e.target.value })}
              placeholder={tt.goalPh}
              rows={10}
              className={cx(inputClass, "resize-y min-h-[160px] font-prose text-[13px] leading-relaxed")}
            />
          </Field>
          <p className={cx("text-right text-[11px]", draft.goal.length > GOAL_MAX ? "text-danger" : "text-muted-foreground")}>
            {tt.goalCount(draft.goal.length, GOAL_MAX)}
          </p>
          {fieldError(["goal", "goalTooLong"])}
        </div>
      )}

      {draft.tab === "manual" && (
        <div className="space-y-1">
          <Field label={tt.topics} htmlFor={id("topics")} hint={tt.topicsHint(topicsCount)}>
            <textarea
              id={id("topics")}
              value={draft.topics}
              disabled={disabled}
              onChange={(e) => set({ topics: e.target.value })}
              placeholder={tt.topicsPh}
              rows={10}
              className={cx(inputClass, "resize-y min-h-[160px]")}
            />
          </Field>
          {fieldError(["topics"])}
        </div>
      )}

      {draft.tab === "repo" && (
        <div className="space-y-1">
          <Field label={tt.repoPath} htmlFor={id("repo")} hint={tt.repoHint}>
            <input
              id={id("repo")}
              type="text"
              value={draft.repoPath}
              disabled={disabled}
              onChange={(e) => set({ repoPath: e.target.value })}
              placeholder={tt.repoPathPh}
              className={inputClass}
            />
          </Field>
          {fieldError(["repo"])}
        </div>
      )}

      {draft.tab === "github" && (
        <div className="space-y-1">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label={tt.githubUrl} htmlFor={id("github")}>
                <input
                  id={id("github")}
                  type="url"
                  value={draft.githubUrl}
                  disabled={disabled}
                  onChange={(e) => {
                    set({ githubUrl: e.target.value });
                    setGhCheck({ busy: false, ok: null, error: null });
                  }}
                  placeholder="https://github.com/owner/repo"
                  className={inputClass}
                />
              </Field>
            </div>
            <Btn onClick={() => void validateGithub()} busy={ghCheck.busy} disabled={disabled || !draft.githubUrl.trim()}>
              {tt.validate}
            </Btn>
          </div>
          <p className="text-[11px] text-muted-foreground/80">{tt.githubHint}</p>
          {ghCheck.ok && <p className="text-[11px] text-success">{ghCheck.ok}</p>}
          {ghCheck.error && <p role="alert" className="text-[11px] text-danger">{ghCheck.error}</p>}
          {fieldError(["github"])}
        </div>
      )}

      {showActivate && (
        <Check
          id={id("activate")}
          checked={draft.activate}
          disabled={disabled}
          onChange={(activate) => set({ activate })}
          label={tt.activateOnCreate}
        />
      )}
    </div>
  );
}
