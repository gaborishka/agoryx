import { ArrowRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { type FolderGit } from "@/components/FolderPicker";
import { ModePicker, ProjectPicker } from "@/components/ConversationOptions";
import { StartScreen } from "@/components/StartScreen";
import { useAttachments } from "@/components/room/Attachments";
import { Button } from "@/components/ui/button";
import { WorkflowSetup } from "@/components/workflow/WorkflowSetup";
import {
  creationDraftKey,
  creationDrafts,
  creationProjectInput,
  useCreationDraft,
} from "@/lib/creation-draft";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { WORK_MODES, isProtocolMode, type WorkMode } from "@/lib/workflow";

/** One creation page owns its attachments and draft while the collaboration method changes. */
export function NewChatScreen() {
  const route = useStore((s) => s.route);
  const dir = route.kind === "new" ? route.dir : undefined;
  const mode: WorkMode =
    route.kind === "workspace"
      ? route.mode
      : route.kind === "new"
        ? (route.mode ?? "chat")
        : "chat";
  useEffect(() => {
    document.title = `${WORK_MODES[mode].title} · Agoryx`;
  }, [route, mode]);
  const key = creationDraftKey(dir);
  const draft = useCreationDraft(key, dir);
  const project = mode === "work" || (isProtocolMode(mode) && draft.project);
  const files = useAttachments({
    canAdd: () => {
      const current = creationDrafts.read(key);
      return !current.preparing && !current.prepared;
    },
  });
  const patch = (next: Parameters<typeof creationDrafts.update>[1]) =>
    creationDrafts.update(key, next);
  const [projectCheck, setProjectCheck] = useState<{
    folder: string;
    git: FolderGit | null;
    error?: string;
    loading: boolean;
  } | null>(null);
  const [checkRevision, setCheckRevision] = useState(0);
  useEffect(() => {
    const folder = draft.folder;
    if (!project || !folder) return;
    let alive = true;
    setProjectCheck({ folder, git: null, loading: true });
    void api<{ git: FolderGit | null }>(
      "GET",
      `/api/fs?path=${encodeURIComponent(folder)}`,
    )
      .then(({ git }) => {
        if (alive) setProjectCheck({ folder, git, loading: false });
      })
      .catch((error: unknown) => {
        if (alive)
          setProjectCheck({
            folder,
            git: null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      alive = false;
    };
  }, [project, draft.folder, checkRevision]);
  const currentCheck =
    projectCheck?.folder === draft.folder ? projectCheck : null;
  const projectProof =
    currentCheck && !currentCheck.loading && !currentCheck.error
      ? currentCheck
      : null;
  const git = projectProof?.git ?? null;
  let projectError: string | null = null;
  try {
    creationProjectInput(draft, projectProof, mode);
  } catch (error) {
    projectError =
      currentCheck?.error ??
      (error instanceof Error ? error.message : String(error));
  }
  const pending = creationDrafts.isPreparing(key);
  const openPrepared = () => {
    const prepared = creationDrafts.read(key).prepared;
    if (!prepared) return;
    if (!isProtocolMode(prepared.mode)) {
      creationDrafts.finish(key, prepared.revision, prepared.roomId);
      useStore.getState().go({ kind: "room", id: prepared.roomId });
    } else
      useStore.getState().openWorkflow(prepared.roomId, prepared.mode, "new");
  };
  const controls = (
    <div className="px-4 pb-3">
      <div
        className="flex flex-wrap items-center gap-2"
        aria-label="Conversation options"
      >
        <ModePicker
          mode={mode}
          onSelect={(next) =>
            useStore
              .getState()
              .go({ kind: "new", ...(dir ? { dir } : {}), mode: next })
          }
        />
        <ProjectPicker
          value={draft.projectKey ?? null}
          workspace={
            project
              ? {
                  folder: draft.folder,
                  onFolder: (folder) =>
                    patch({
                      folder,
                      base: null,
                      ...(!folder ? { worktree: false } : {}),
                    }),
                  git,
                  worktree: draft.worktree,
                  onWorktree: (worktree) => patch({ worktree }),
                  base: draft.base,
                  onBase: (base) => patch({ base }),
                }
              : undefined
          }
          onSelect={(projectKey) =>
            patch({
              projectKey,
              project: Boolean(projectKey),
              folder: projectKey,
              base: null,
              worktree: false,
            })
          }
        />
      </div>
      {projectError ? (
        <div
          role="status"
          className="mt-2 flex flex-wrap items-center gap-2 text-meta text-amber-ink"
        >
          <span>
            {currentCheck?.loading
              ? "Checking the selected folder…"
              : projectError}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={currentCheck?.loading}
            onClick={() => setCheckRevision((n) => n + 1)}
          >
            Retry
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => patch({ worktree: false, base: null })}
          >
            Use folder directly
          </Button>
        </div>
      ) : null}
    </div>
  );
  return (
    <div className="@container/workflow new-workspace flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-4 pt-5 @min-[600px]/workflow:px-8">
          {files.items.length && isProtocolMode(mode) ? (
            <p className="mt-4 rounded-xl border border-border bg-card px-4 py-3 text-small leading-relaxed text-muted-foreground">
              {files.items.length} attachment
              {files.items.length === 1 ? " is" : "s are"} kept in your Chat
              draft on this page. Private sessions use explicitly selected text
              files; these attachments are not included. Switch back to Chat to
              review them.
            </p>
          ) : null}
          {draft.prepared ? (
            <section
              className="mt-5 rounded-xl border border-border bg-card p-4"
              aria-label="Created chat"
            >
              <h2 className="text-ui font-semibold">
                Your{" "}
                {WORK_MODES[draft.prepared.mode].title.toLowerCase() === "chat"
                  ? "chat"
                  : `${WORK_MODES[draft.prepared.mode].title.toLowerCase()} chat`}{" "}
                is ready
              </h2>
              <p className="mt-1 text-small text-muted-foreground">
                Continue in the chat already created for this draft.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={openPrepared}>
                  Open created chat <ArrowRightIcon className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => creationDrafts.release(key)}
                >
                  Start another chat
                </Button>
              </div>
            </section>
          ) : draft.preparing ? (
            <section
              className="mt-5 rounded-xl border border-border bg-card p-4"
              aria-live="polite"
            >
              <p className="text-small">
                {pending
                  ? "Preparing your chat…"
                  : "The creation result could not be confirmed. Check the chat list before trying again."}
              </p>
              {!pending ? (
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => creationDrafts.release(key)}
                >
                  I checked the chat list · start another
                </Button>
              ) : null}
            </section>
          ) : null}
        </div>
        {mode ? (
          <fieldset
            disabled={Boolean(draft.prepared || draft.preparing)}
            className="min-w-0 border-0 p-0 disabled:opacity-60"
          >
            {!isProtocolMode(mode) ? (
              <StartScreen
                key={`${key}:${mode}`}
                mode={mode}
                draftKey={key}
                controls={controls}
                files={files}
                projectProof={projectProof}
                projectError={projectError}
              />
            ) : (
              <WorkflowSetup
                key={`${key}:${mode}`}
                mode={mode}
                creationKey={key}
                controls={controls}
                projectProof={projectProof}
                projectError={projectError}
              />
            )}
          </fieldset>
        ) : null}
      </div>
    </div>
  );
}
