import { FolderIcon, FolderOpenIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { FolderDialog } from "@/components/FolderPicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, Unauthorized } from "@/lib/api";
import { baseName, shortPath } from "@/lib/format";
import { errText } from "@/lib/load";
import { useStore } from "@/lib/store";
import type { ProjectView } from "@/lib/types";

/**
 * New project: a name (and a goal, and other folders) written for a folder, by the human. The folder is the project —
 * a Work room opened in it later is in it, as before. A folder that already has a name is opened, not written over.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectView) => void;
}) {
  const go = useStore((s) => s.go);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [dir, setDir] = useState("");
  const [context, setContext] = useState<string[]>([]);
  /** Which folder the browser picks for: the project's own, or one more context folder. */
  const [browse, setBrowse] = useState<"dir" | "context" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The folder is a project already: the one to open instead. */
  const [existing, setExisting] = useState<ProjectView | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setGoal("");
    setDir("");
    setContext([]);
    setError(null);
    setExisting(null);
  }, [open]);

  const create = async () => {
    if (!name.trim() || !dir.trim() || busy) return;
    setBusy(true);
    setError(null);
    setExisting(null);
    try {
      const got = await api<{ project: ProjectView }>("POST", "/api/projects", { dir: dir.trim(), name: name.trim(), goal: goal.trim(), context });
      onOpenChange(false);
      onCreated(got.project);
    } catch (err) {
      if (err instanceof Unauthorized) return;
      if (err instanceof ApiError && err.status === 409 && err.body.project) setExisting(err.body.project as ProjectView);
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>A folder its Work rooms share, with what every agent there starts with.</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-project-name">Name</Label>
            <Input id="new-project-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={dir ? baseName(dir) : "Agoryx"} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-project-goal">Goal</Label>
            <Textarea
              id="new-project-goal"
              rows={3}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="What the work here is for. Agents get it when a session starts."
              className="resize-y text-small"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-project-dir">Folder</Label>
            <div className="flex gap-2">
              <Input
                id="new-project-dir"
                value={dir}
                onChange={(event) => setDir(event.target.value)}
                placeholder="~/code/my-app"
                className="font-mono text-meta"
              />
              <Button type="button" variant="outline" onClick={() => setBrowse("dir")}>
                <FolderOpenIcon className="size-4" /> Browse
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center">
              <Label>Context</Label>
              <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setBrowse("context")}>
                <PlusIcon className="size-3.5" /> Add folder
              </Button>
            </div>
            {context.length ? (
              <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/70">
                {context.map((path) => (
                  <li key={path} className="flex items-center gap-2 px-3 py-1.5">
                    <FolderIcon className="size-3.5 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate font-mono text-meta" title={path}>
                      {shortPath(path)}
                    </span>
                    <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${path}`} onClick={() => setContext(context.filter((entry) => entry !== path))}>
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-small text-muted-foreground">Other folders its agents may read and write too: a second repository, shared docs.</p>
            )}
          </div>
          {error ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-soft px-3 py-2 text-small">
              <span className="min-w-0 flex-1">{error}</span>
              {existing ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    onOpenChange(false);
                    go({ kind: "project", hash: existing.hash });
                  }}
                >
                  Open it
                </Button>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || !dir.trim() || busy}>
              Create project
            </Button>
          </DialogFooter>
        </form>
        <FolderDialog
          open={browse !== null}
          onOpenChange={(next) => !next && setBrowse(null)}
          start={browse === "dir" ? dir || null : (dir.slice(0, dir.lastIndexOf("/")) || null)}
          title={browse === "dir" ? "The project's folder" : "A context folder"}
          description={browse === "dir" ? "Its Work rooms work here." : "Its agents may read and write it too."}
          onPick={(path) => {
            if (browse === "dir") setDir(path);
            else if (!context.includes(path)) setContext([...context, path]);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
