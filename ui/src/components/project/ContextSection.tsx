import { FolderIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Hint } from "@/components/common/states";
import { FolderDialog } from "@/components/FolderPicker";
import { Button } from "@/components/ui/button";
import { api, Unauthorized } from "@/lib/api";
import { baseName, shortPath } from "@/lib/format";
import { errText } from "@/lib/load";
import type { ProjectView } from "@/lib/types";
import { Block } from "./Block";

/**
 * A project's context folders: other folders (a second repo, shared docs) its Work rooms' agents may read and write
 * as they do its own. Claude gets them as --add-dir, Codex as writable roots; an agent's next turn has them.
 */
export function ContextSection({ project, onChange }: { project: ProjectView; onChange: (project: ProjectView) => void }) {
  const [browse, setBrowse] = useState(false);
  const [busy, setBusy] = useState(false);
  const parent = project.key.slice(0, project.key.lastIndexOf("/")) || "/";

  const send = async (method: "POST" | "DELETE", path: string) => {
    setBusy(true);
    try {
      const url = `/api/projects/${project.hash}/context${method === "DELETE" ? `?path=${encodeURIComponent(path)}` : ""}`;
      const got = await api<{ project: ProjectView }>(method, url, method === "POST" ? { path } : undefined);
      onChange(got.project);
      toast.success(method === "POST" ? `Added ${baseName(path)}. Conversation agents get it on their next turn.` : `Removed ${baseName(path)}.`);
    } catch (err) {
      if (!(err instanceof Unauthorized)) toast.error(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Block
      title="Context"
      aside={
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setBrowse(true)}>
          <PlusIcon className="size-3.5" /> Add folder
        </Button>
      }
    >
      <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/70">
        <li className="flex items-center gap-3 px-3.5 py-2.5">
          <FolderIcon className="size-4 shrink-0 text-faint" />
          <span className="min-w-0 flex-1 truncate font-mono text-meta" title={project.key}>
            {shortPath(project.key)}
          </span>
          <span className="shrink-0 text-meta text-faint">its own folder</span>
        </li>
        {project.context.map((path) => (
          <li key={path} className="flex items-center gap-3 px-3.5 py-2.5">
            <FolderIcon className="size-4 shrink-0 text-faint" />
            <span className="min-w-0 flex-1 truncate font-mono text-meta" title={path}>
              {shortPath(path)}
            </span>
            <Button type="button" variant="ghost" size="icon" className="size-7" disabled={busy} aria-label={`Remove ${path}`} onClick={() => void send("DELETE", path)}>
              <XIcon className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      {project.context.length === 0 ? (
        <Hint>Another repository or a folder of docs conversation agents should read and write too, starting with their next turn.</Hint>
      ) : null}
      <FolderDialog
        open={browse}
        onOpenChange={setBrowse}
        start={parent}
        onPick={(path) => void send("POST", path)}
        title="A context folder"
        description="Conversation agents may read and write this folder from their next turn."
      />
    </Block>
  );
}
