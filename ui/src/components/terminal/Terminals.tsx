import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { type ILink, Terminal } from "@xterm/xterm";
import { ChevronDownIcon, Columns2Icon, PlusIcon, SquareTerminalIcon, Trash2Icon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, local, roomPath, Unauthorized } from "@/lib/api";
import { keyLabel } from "@/lib/keys";
import { errText } from "@/lib/load";
import { useStore } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

// The room's terminals, as in T3 Code: a drawer under the room with tabs, each tab up to four shells side by side.
// The shells run in the daemon (node-pty) in the room's folder and live on when the page is closed; a page
// attaching gets what they printed so far, then the rest live over a WebSocket. They are the human's alone.

interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  exit: number | null;
}

const MAX_SPLIT = 4;

/** The tabs of a room: groups of terminal ids, kept in this browser (the terminals themselves are the daemon's). */
const loadGroups = (room: string): string[][] => {
  try {
    const parsed = JSON.parse(local.get(`terminals.${room}`) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((g): g is string[] => Array.isArray(g) && g.every((id) => typeof id === "string")) : [];
  } catch {
    return [];
  }
};
const saveGroups = (room: string, groups: string[][]) => local.set(`terminals.${room}`, groups.length ? JSON.stringify(groups) : null);

/** A CSS colour (the page's tokens may be oklch) as xterm's #rrggbb. */
const probe = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d", { willReadFrequently: true }) : null;
const hex = (color: string) => {
  if (!probe) return color;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, "0")).join("")}`;
};

/** The terminal in the page's own colours, light or dark. */
const themeOf = (dark: boolean) => {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => hex(css.getPropertyValue(name).trim() || "#888");
  const background = v("--code");
  const foreground = v("--foreground");
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? "#3a4a40" : "#cfdccf",
    black: dark ? "#2a2f2b" : "#1b211d",
    brightBlack: v("--faint"),
    red: dark ? "#e0785c" : "#b4533a",
    brightRed: dark ? "#f0907a" : "#c9664b",
    green: dark ? "#8fbf8a" : "#3f7a4f",
    brightGreen: dark ? "#a8d6a2" : "#4f9161",
    yellow: dark ? "#d8b46a" : "#94701f",
    brightYellow: dark ? "#e8c882" : "#a8842f",
    blue: dark ? "#7ea6d8" : "#2f5f95",
    brightBlue: dark ? "#98bbe6" : "#3f72ab",
    magenta: dark ? "#c49ad8" : "#7f4f98",
    brightMagenta: dark ? "#d4b0e6" : "#9262ad",
    cyan: dark ? "#7cc4c0" : "#2d7d78",
    brightCyan: dark ? "#98d8d4" : "#3a948e",
    white: dark ? "#d8dcd6" : "#5d675f",
    brightWhite: dark ? "#f3f5f1" : "#1b211d",
  };
};

// Paths a shell prints (T3 Code's pattern): ./a, ../a, /abs/a, ~/a, C:\a, or a/b/c, each with an optional :line:col.
const PATH = /(?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}/g;

/** A printed path as a file of the room's folder, or null when it is outside it or not a file's name. */
const workspaceFile = (raw: string, cwd: string, workspace: string): string | null => {
  let path = raw.replace(/[),.;:]+$/, "").replace(/(?::\d+){1,2}$/, "");
  if (/^[a-z]+:\/\//i.test(path) || path.startsWith("~")) return null;
  if (!path.startsWith("/")) path = `${cwd.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const full = `/${parts.join("/")}`;
  const root = workspace.replace(/\/+$/, "");
  if (!full.startsWith(`${root}/`)) return null;
  const rel = full.slice(root.length + 1);
  return /\.[A-Za-z0-9]+$/.test(rel) || rel.includes("/") ? rel : null;
};

function TerminalView({ room, info, workspace, focused, onFocus, onGone }: { room: string; info: TerminalInfo; workspace: string; focused: boolean; onFocus: () => void; onGone: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const dark = useTheme((t) => t.dark);
  const gone = useRef(onGone);
  gone.current = onGone;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const terminal = new Terminal({
      fontFamily: css.getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeOf(useTheme.getState().dark),
    });
    term.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
    // The page's own keys pass through: ⌃` hides the drawer.
    terminal.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.code === "Backquote"));
    // A path the shell printed opens in the editor, when it is a file of the room's folder.
    terminal.registerLinkProvider({
      provideLinks(line, callback) {
        const text = terminal.buffer.active.getLine(line - 1)?.translateToString(true) ?? "";
        const links: ILink[] = [];
        for (const match of text.matchAll(PATH)) {
          const file = workspaceFile(match[0], info.cwd, workspace);
          if (!file) continue;
          const start = match.index ?? 0;
          links.push({
            text: match[0],
            range: { start: { x: start + 1, y: line }, end: { x: start + match[0].length, y: line } },
            activate: () => useStore.getState().openFile(file),
          });
        }
        callback(links.length ? links : undefined);
      },
    });
    terminal.open(el);
    fit.fit();

    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const send = (message: unknown) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${scheme}://${location.host}${roomPath(room, `/terminals/${encodeURIComponent(info.id)}/socket`)}`);
      socket = ws;
      ws.onopen = () => {
        tries = 0;
        send({ t: "resize", cols: terminal.cols, rows: terminal.rows });
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { t: string; d?: string; code?: number };
        if (message.t === "replay") {
          terminal.reset();
          terminal.write(message.d ?? "");
        } else if (message.t === "out") terminal.write(message.d ?? "");
        else if (message.t === "exit") terminal.write(`\r\n\x1b[2m[процес завершився${message.code != null ? `, код ${message.code}` : ""}]\x1b[0m\r\n`);
        else if (message.t === "closed") {
          closed = true;
          gone.current();
        }
      };
      ws.onclose = () => {
        if (closed || socket !== ws) return;
        // The daemon restarting, or the terminal gone: try again a few times, then ask the list.
        tries += 1;
        if (tries > 5) {
          gone.current();
          return;
        }
        retry = setTimeout(connect, Math.min(4000, 500 * tries));
      };
    };
    connect();
    const input = terminal.onData((d) => send({ t: "in", d }));
    const resized = terminal.onResize(({ cols, rows }) => send({ t: "resize", cols, rows }));
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
      });
    });
    observer.observe(el);
    return () => {
      closed = true;
      clearTimeout(retry);
      cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      resized.dispose();
      socket?.close();
      terminal.dispose();
      term.current = null;
    };
  }, [room, info.id, info.cwd, workspace]);

  useEffect(() => {
    if (term.current) term.current.options.theme = themeOf(dark);
  }, [dark]);
  useEffect(() => {
    if (focused) term.current?.focus();
  }, [focused]);

  return (
    <div className={cn("relative min-h-0 min-w-0 flex-1 bg-code", focused ? "" : "opacity-95")} onPointerDown={onFocus}>
      <div ref={host} className="absolute inset-0 py-1 pl-2" />
    </div>
  );
}

export function TerminalDrawer() {
  const room = useStore((s) => s.snap?.state.id ?? "");
  const workspace = useStore((s) => s.snap?.state.workspace ?? "");
  const height = useStore((s) => s.terminalHeight);
  const setHeight = useStore((s) => s.setTerminalHeight);
  const setOpen = useStore((s) => s.setTerminalOpen);
  const request = useStore((s) => s.terminalRequest);
  const [list, setList] = useState<TerminalInfo[] | null>(null);
  const [groups, setGroupsState] = useState<string[][]>(() => loadGroups(room));
  const [active, setActive] = useState(0);
  const [focus, setFocus] = useState<string | null>(null);
  const handled = useRef<number | null>(null);

  const setGroups = useCallback(
    (next: string[][]) => {
      saveGroups(room, next);
      setGroupsState(next);
    },
    [room],
  );

  const fail = (error: unknown) => !(error instanceof Unauthorized) && toast.error(errText(error));

  /** The daemon's terminals, with the tabs made to match them. */
  const refresh = useCallback(async () => {
    const { terminals } = await api<{ terminals: TerminalInfo[] }>("GET", roomPath(room, "/terminals"));
    setList(terminals);
    const ids = new Set(terminals.map((t) => t.id));
    const kept = loadGroups(room)
      .map((g) => g.filter((id) => ids.has(id)))
      .filter((g) => g.length);
    const placed = new Set(kept.flat());
    const next = [...kept, ...terminals.filter((t) => !placed.has(t.id)).map((t) => [t.id])];
    setGroups(next);
    return next;
  }, [room, setGroups]);

  const open = useCallback(
    async (into: number | null, text?: string) => {
      const body = { cols: 100, rows: 24, ...(text ? { text } : {}) };
      const { terminal } = await api<{ terminal: TerminalInfo }>("POST", roomPath(room, "/terminals"), body);
      setList((was) => [...(was ?? []), terminal]);
      const now = loadGroups(room);
      const next = into !== null && now[into] ? now.map((g, i) => (i === into ? [...g, terminal.id] : g)) : [...now, [terminal.id]];
      setGroups(next);
      setActive(into !== null && now[into] ? into : next.length - 1);
      setFocus(terminal.id);
    },
    [room, setGroups],
  );

  // First look: the room's terminals; none yet opens one, as a terminal drawer should.
  useEffect(() => {
    setGroupsState(loadGroups(room));
    setActive(0);
    let live = true;
    refresh()
      .then((next) => {
        if (!live) return;
        const asked = useStore.getState().terminalRequest;
        if (!next.length && !(asked && handled.current !== asked.at)) void open(null).catch(fail);
      })
      .catch(fail);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // «Continue in the terminal»: a new tab with the command typed in.
  useEffect(() => {
    if (!request || handled.current === request.at) return;
    handled.current = request.at;
    void open(null, request.text).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const close = async (id: string) => {
    await api("POST", roomPath(room, `/terminals/${encodeURIComponent(id)}/close`), {}).catch(() => {});
    dropped(id);
  };
  const dropped = (id: string) => {
    setList((was) => was?.filter((t) => t.id !== id) ?? was);
    const next = loadGroups(room)
      .map((g) => g.filter((x) => x !== id))
      .filter((g) => g.length);
    setGroups(next);
    setActive((a) => Math.min(a, Math.max(0, next.length - 1)));
    if (!next.length) setOpen(false);
  };
  const closeGroup = async (index: number) => {
    for (const id of groups[index] ?? []) await close(id);
  };

  // The top edge drags the drawer taller or shorter.
  const drag = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const start = height;
    const move = (e: PointerEvent) => setHeight(start + (startY - e.clientY));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const byId = new Map((list ?? []).map((t) => [t.id, t]));
  const current = groups[active] ?? [];
  const focused = focus && current.includes(focus) ? focus : (current[0] ?? null);

  return (
    <section aria-label="Термінал" className="relative flex shrink-0 flex-col border-t border-border/70 bg-code" style={{ height }}>
      <div role="separator" aria-orientation="horizontal" aria-label="Висота термінала" onPointerDown={drag} className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize" />
      <div className="flex h-8 shrink-0 items-stretch border-b border-border/70 bg-background/60">
        <div role="tablist" aria-label="Термінали" className="scroll-thin flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {groups.map((group, index) => {
            const on = index === active;
            const title = group.map((id) => byId.get(id)?.title ?? id).join(" · ");
            return (
              <div key={group.join(",")} className={cn("group flex max-w-56 shrink-0 items-center gap-1 border-r border-border/70 pr-1 pl-2.5 text-small", on ? "bg-code text-foreground" : "text-muted-foreground hover:text-foreground")}>
                <button type="button" role="tab" aria-selected={on} onClick={() => setActive(index)} className="flex min-w-0 items-center gap-1.5" title={title}>
                  <SquareTerminalIcon className="size-3.5 shrink-0" />
                  <span className="truncate font-mono text-meta">{title}</span>
                </button>
                <button
                  type="button"
                  aria-label="Закрити термінал"
                  onClick={() => void closeGroup(index)}
                  className={cn("grid size-5 shrink-0 place-items-center rounded hover:bg-accent", on ? "opacity-70" : "opacity-0 group-hover:opacity-70 focus:opacity-70")}
                >
                  <Trash2Icon className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Поділити" title="Поділити: ще один термінал поруч" disabled={!current.length || current.length >= MAX_SPLIT} onClick={() => void open(active).catch(fail)}>
            <Columns2Icon className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Новий термінал" title="Новий термінал" onClick={() => void open(null).catch(fail)}>
            <PlusIcon className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Закрити цей термінал" title="Закрити цей термінал" disabled={!focused} onClick={() => focused && void close(focused)}>
            <Trash2Icon className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Сховати термінал" title={`Сховати (${keyLabel("terminal")}) — термінали працюють далі`} onClick={() => setOpen(false)}>
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {groups.map((group, index) => (
          <div key={group.join(",")} className={cn("min-h-0 flex-1 divide-x divide-border/70", index === active ? "flex" : "hidden")}>
            {group.map((id) => {
              const info = byId.get(id);
              return info ? (
                <TerminalView key={id} room={room} info={info} workspace={workspace} focused={index === active && id === focused} onFocus={() => setFocus(id)} onGone={() => void refresh().then(() => dropped(id)).catch(() => dropped(id))} />
              ) : null;
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
