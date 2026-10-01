import { FileIcon, PaperclipIcon, XIcon } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { ext, IMAGE_EXT, kb } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The daemon's bound on one file (uploads.ts MAX_UPLOAD). */
const MAX_FILE = 20 * 1024 * 1024;

type Attachment = { id: string; file: File; name: string; preview: string | null };

let seq = 0;

/** A pasted screenshot comes as "image.png": give it a name that tells it apart. */
const nameOf = (file: File) => {
  if (file.name && file.name !== "image.png") return file.name;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `pasted-${stamp}.${file.type.split("/")[1]?.replace("jpeg", "jpg") || "png"}`;
};

const base64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error(`can't read ${file.name}`));
    reader.readAsDataURL(file);
  });

/** A path in a markdown link: the link holds whatever the folder names are. */
const href = (path: string) => encodeURI(path).replace(/[()#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Files attached to the next message: picked, pasted or dropped. On send each is kept by the daemon and the
 * message links it by path — an image as an embed the room shows, any other file as a link the agents open.
 */
export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const live = useRef(items);
  live.current = items;
  useEffect(() => () => live.current.forEach((a) => a.preview && URL.revokeObjectURL(a.preview)), []);

  const add = (files: Iterable<File>) => {
    const next: Attachment[] = [];
    for (const file of files) {
      if (file.size > MAX_FILE) {
        toast.error(`${file.name} is larger than 20 MB`);
        continue;
      }
      if (!file.size) {
        toast.error(`${file.name || "The file"} is empty`);
        continue;
      }
      const name = nameOf(file);
      next.push({ id: `a${++seq}`, file, name, preview: IMAGE_EXT.has(ext(name)) ? URL.createObjectURL(file) : null });
    }
    if (next.length) setItems((prev) => [...prev, ...next]);
  };
  const remove = (id: string) =>
    setItems((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((a) => a.id !== id);
    });
  const clear = () =>
    setItems((prev) => {
      prev.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
      return [];
    });
  /** Uploads every file and returns the lines to put under the message. */
  const upload = async (): Promise<string> => {
    const lines: string[] = [];
    for (const a of live.current) {
      const { path } = await api<{ path: string }>("POST", "/api/uploads", { name: a.name, data: await base64(a.file) });
      lines.push(a.preview ? `![${a.name}](${href(path)})` : `[${a.name}](${href(path)})`);
    }
    return lines.join("\n\n");
  };
  /** Pasted files (a screenshot, files copied in Finder) attach; pasted text stays text. */
  const onPaste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    add(files);
  };
  const [over, setOver] = useState(false);
  const drop = {
    onDragOver: (event: DragEvent) => {
      if (!Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault();
      setOver(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (event: DragEvent) => {
      setOver(false);
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      add(Array.from(event.dataTransfer.files));
    },
  };
  return { items, add, remove, clear, upload, onPaste, drop, over };
}

/** A body for a message: its text, then its files. */
export const withFiles = (text: string, files: string) => [text, files].filter(Boolean).join("\n\n");

export function AttachButton({ onFiles, disabled, className }: { onFiles: (files: File[]) => void; disabled?: boolean; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        onClick={() => input.current?.click()}
        aria-label="Attach files"
        title="Attach files — or paste an image, or drop files here"
        className={cn("size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground", className)}
      >
        <PaperclipIcon className="size-4" />
      </Button>
    </>
  );
}

export function AttachmentList({ items, onRemove, className }: { items: Attachment[]; onRemove: (id: string) => void; className?: string }) {
  if (!items.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {items.map((a) =>
        a.preview ? (
          <div key={a.id} className="group relative size-16 shrink-0 overflow-hidden rounded-lg border border-border bg-muted" title={a.name}>
            <img src={a.preview} alt={a.name} className="size-full object-cover" />
            <Remove name={a.name} onClick={() => onRemove(a.id)} />
          </div>
        ) : (
          <div key={a.id} className="group relative flex h-16 max-w-56 min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/50 pr-7 pl-2.5" title={a.name}>
            <FileIcon className="size-5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-small">{a.name}</span>
              <span className="text-meta text-faint">{kb(a.file.size)}</span>
            </span>
            <Remove name={a.name} onClick={() => onRemove(a.id)} />
          </div>
        ),
      )}
    </div>
  );
}

function Remove({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Remove ${name}`}
      className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-foreground/70 text-background opacity-90 transition hover:bg-foreground group-hover:opacity-100"
    >
      <XIcon className="size-3" />
    </button>
  );
}
