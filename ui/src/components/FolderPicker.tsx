import {
  CheckIcon,
  ChevronDownIcon,
  CornerLeftUpIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GitBranchIcon,
  HomeIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Tip } from "@/components/room/bits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { api, ApiError, Unauthorized } from "@/lib/api";
import { baseName, shortPath } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export interface FolderGit {
  root: string;
  prefix: string;
  branch: string | null;
  head: string | null;
  branches: string[];
  linked: boolean;
  dirty: number;
}

interface FsReply {
  path: string;
  parent: string | null;
  home: string;
  git: FolderGit | null;
  dirs: Array<{ name: string; path: string; git: boolean }>;
}

interface Recent {
  path: string;
  name: string;
  git: boolean;
}

const fetchFolder = (path: string) =>
  api<FsReply>("GET", `/api/fs?path=${encodeURIComponent(path)}`);

/** What git says about the picked folder; null while unknown or when it is not a repository. */
export function useFolderGit(
  path: string | null,
  onGone: () => void,
): FolderGit | null {
  const [git, setGit] = useState<FolderGit | null>(null);
  useEffect(() => {
    setGit(null);
    if (!path) return;
    let live = true;
    fetchFolder(path)
      .then((reply) => live && setGit(reply.git))
      .catch((error) => {
        if (live && error instanceof ApiError && error.status === 404) onGone();
      });
    return () => {
      live = false;
    };
    // onGone is a fresh closure each render; the folder alone decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  return git;
}

const chip =
  "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-small text-muted-foreground transition hover:bg-card hover:text-foreground data-[state=open]:bg-card data-[state=open]:text-foreground";

/**
 * Where the room works: a folder (or a fresh one Agoryx makes), and in a git repository the branch
 * and whether the room gets its own worktree — one branch and folder both agents share.
 */
export function FolderBar({
  folder,
  onFolder,
  git,
  worktree,
  onWorktree,
  base,
  onBase,
}: {
  folder: string | null;
  onFolder: (path: string | null) => void;
  git: FolderGit | null;
  worktree: boolean;
  onWorktree: (on: boolean) => void;
  base: string | null;
  onBase: (branch: string) => void;
}) {
  const [recent, setRecent] = useState<Recent[]>([]);
  const [browse, setBrowse] = useState(false);
  useEffect(() => {
    api<{ recent: Recent[] }>("GET", "/api/folders")
      .then((reply) => setRecent(reply.recent))
      .catch(() => {});
  }, []);
  const list =
    folder && !recent.some((r) => r.path === folder)
      ? [{ path: folder, name: baseName(folder), git: Boolean(git) }, ...recent]
      : recent;
  const canWorktree = Boolean(git?.head);
  const from = base ?? git?.branch ?? git?.head ?? "HEAD";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <Tip
            tip={folder ? folder : "Agoryx will create a new git folder in ~/agoryx"}
          >
            <DropdownMenuTrigger className={cn(chip, "max-w-[260px]")}>
              {folder ? (
                git ? (
                  <FolderGit2Icon className="size-4 shrink-0" />
                ) : (
                  <FolderIcon className="size-4 shrink-0" />
                )
              ) : (
                <FolderPlusIcon className="size-4 shrink-0" />
              )}
              <span className="truncate font-medium text-foreground">
                {folder ? baseName(folder) : "New folder"}
              </span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuItem
              onSelect={() => onFolder(null)}
              className="items-start gap-2.5 py-2"
            >
              <FolderPlusIcon className="mt-0.5" />
              <span className="flex min-w-0 flex-1 flex-col">
                New folder
                <small className="text-xs text-muted-foreground">
                  An empty git folder in ~/agoryx
                </small>
              </span>
              {!folder ? <CheckIcon className="mt-0.5 text-primary" /> : null}
            </DropdownMenuItem>
            {list.length ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Recent
                </DropdownMenuLabel>
                {list.map((r) => (
                  <DropdownMenuItem
                    key={r.path}
                    onSelect={() => onFolder(r.path)}
                    className="gap-2.5"
                  >
                    {r.git ? <FolderGit2Icon /> : <FolderIcon />}
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate">{r.name}</span>
                      <small className="truncate font-mono text-micro text-faint">
                        {shortPath(r.path)}
                      </small>
                    </span>
                    {folder === r.path ? (
                      <CheckIcon className="text-primary" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setBrowse(true)}
              className="gap-2.5"
            >
              <FolderOpenIcon />
              Open folder…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {folder && git ? (
          <div className={cn(chip, "gap-0 p-0 hover:bg-card")}>
            {worktree && git.branches.length ? (
              <DropdownMenu>
                <Tip tip={t.worktree.from}>
                  <DropdownMenuTrigger className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-l-lg pr-2 pl-2.5 hover:text-foreground">
                    <GitBranchIcon className="size-4 shrink-0" />
                    <span className="max-w-[160px] truncate font-medium text-foreground">
                      {from}
                    </span>
                    <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
                  </DropdownMenuTrigger>
                </Tip>
                <DropdownMenuContent
                  align="start"
                  className="max-h-80 w-64 overflow-y-auto"
                >
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    {t.worktree.fromMenu}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={from} onValueChange={onBase}>
                    {git.branches.map((b) => (
                      <DropdownMenuRadioItem
                        key={b}
                        value={b}
                        className="font-mono text-small"
                      >
                        <span className="truncate">{b}</span>
                        {b === git.branch ? (
                          <span className="ml-auto pl-2 font-sans text-micro text-faint">
                            current
                          </span>
                        ) : null}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Tip
                tip={
                  git.branch
                    ? `Agents work right in this folder, on branch ${git.branch}`
                    : "HEAD is detached from any branch"
                }
              >
                <span className="inline-flex h-full min-w-0 items-center gap-1.5 pr-2 pl-2.5">
                  <GitBranchIcon className="size-4 shrink-0" />
                  <span className="max-w-[160px] truncate font-medium text-foreground">
                    {git.branch ?? git.head ?? "—"}
                  </span>
                </span>
              </Tip>
            )}
            <span className="h-4 w-px bg-border" />
            <Tip
              tip={
                canWorktree
                  ? t.worktree.about
                  : t.worktree.noCommits
              }
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={worktree}
                disabled={!canWorktree}
                onClick={() => onWorktree(!worktree)}
                className="inline-flex h-full items-center gap-1.5 rounded-r-lg pr-2.5 pl-2 hover:text-foreground disabled:opacity-50"
              >
                <span
                  className={cn(
                    "grid size-3.5 place-items-center rounded border transition",
                    worktree
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background",
                  )}
                >
                  {worktree ? (
                    <CheckIcon className="size-3" strokeWidth={3} />
                  ) : null}
                </span>
                {t.worktree.label}
              </button>
            </Tip>
          </div>
        ) : null}
      </div>
      {folder && git && worktree && git.dirty && from === git.branch ? (
        <p className="flex items-start gap-1.5 text-xs text-amber">
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
          {t.worktree.dirty(git.dirty, baseName(folder), git.branch)}
        </p>
      ) : null}
      <FolderDialog
        open={browse}
        onOpenChange={setBrowse}
        start={folder}
        onPick={onFolder}
      />
    </div>
  );
}

/** Browse the machine's folders (via the daemon) and pick one for the room. */
export function FolderDialog({
  open,
  onOpenChange,
  start,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  start: string | null;
  onPick: (path: string) => void;
}) {
  const [data, setData] = useState<FsReply | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const go = async (path: string) => {
    try {
      const reply = await fetchFolder(path);
      setData(reply);
      setInput(reply.path);
      setError(null);
    } catch (e) {
      if (e instanceof Unauthorized) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    if (open) void go(start ?? "~");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const pick = () => {
    if (!data) return;
    onPick(data.path);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(640px,88vh)] flex-col gap-3 sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          field.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Folder for the room</DialogTitle>
          <DialogDescription>
            Agents will work in it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void go(input);
          }}
        >
          <Tip tip="Up one level">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 shrink-0"
              disabled={!data?.parent}
              onClick={() => data?.parent && void go(data.parent)}
              aria-label="Up one level"
            >
              <CornerLeftUpIcon className="size-4" />
            </Button>
          </Tip>
          <Tip tip="Home folder">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 shrink-0"
              onClick={() => void go("~")}
              aria-label="Home folder"
            >
              <HomeIcon className="size-4" />
            </Button>
          </Tip>
          <Input
            ref={field}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            className="h-9 font-mono text-small"
            aria-label="Path"
          />
        </form>
        {error ? <p className="text-small text-destructive">{error}</p> : null}
        {data?.git ? (
          <div className="flex items-center gap-2 rounded-lg bg-secondary/70 px-3 py-2 text-small text-secondary-foreground">
            <FolderGit2Icon className="size-4 shrink-0" />
            <span className="min-w-0 truncate">
              git repository
              {data.git.prefix
                ? `, folder ${data.git.prefix.replace(/\/$/, "")}`
                : ""}
              {data.git.branch ? (
                <>
                  {" "}
                  · branch{" "}
                  <b className="font-mono font-semibold">{data.git.branch}</b>
                </>
              ) : null}
            </span>
          </div>
        ) : null}
        <div className="scroll-thin -mx-2 min-h-[180px] flex-1 overflow-y-auto">
          {data && !data.dirs.length ? (
            <p className="px-3 py-6 text-center text-small text-muted-foreground">
              No subfolders here
            </p>
          ) : null}
          <ul className="flex flex-col">
            {data?.dirs.map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  onClick={() => void go(d.path)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-ui transition hover:bg-accent"
                >
                  {d.git ? (
                    <FolderGit2Icon className="size-4 shrink-0 text-primary" />
                  ) : (
                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{d.name}</span>
                  {d.git ? (
                    <span className="ml-auto text-micro text-faint">git</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={pick}
            disabled={!data}
            className="max-w-full min-w-0"
          >
            <span className="truncate">
              Choose {data ? baseName(data.path) || data.path : ""}
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
