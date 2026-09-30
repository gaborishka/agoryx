/**
 * Shortcuts as the viewer's keyboard names them: ⌘ on a Mac, Ctrl elsewhere, and the one list of the page's
 * keys (the palette and the «?» overlay show it; hooks/use-shortcuts.ts handles it).
 */
const platform = typeof navigator === "undefined" ? "" : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "");

export const isMac = /mac|iphone|ipad|ipod/i.test(platform);

/** In the Agoryx app (its preload gives the page the room's browser): no browser tabs to collide with. */
const inApp = typeof window !== "undefined" && "agoryxBrowser" in window;

/** The modifier's own label: "⌘" or "Ctrl". */
export const modKey = isMac ? "⌘" : "Ctrl";

/** A shortcut with the modifier: "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export const withMod = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);

/** Focus is where Esc and letters belong to the text, not to the page. */
export const typingIn = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || (target.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "range"].includes((target as HTMLInputElement).type));
};

/**
 * One key with its modifiers. `code` is the physical key, so a shortcut works in the Ukrainian layout too;
 * `key` also matches, for keyboards where the character sits elsewhere ("/", "?").
 */
interface Chord {
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
  code?: string;
  key?: string;
  /** How the key itself is written: "K", "↑", "Enter". */
  label: string;
}

export type ShortcutId =
  | "palette"
  | "settings"
  | "keys"
  | "compose"
  | "prevRoom"
  | "nextRoom"
  | "chat"
  | "table"
  | "panel"
  | "session"
  | "stop"
  | "close"
  | "send"
  | "newline"
  | "formSend"
  | "docSave"
  | "modelDigit";

/**
 * Where a key works. "always": while typing too (modifier chords); "idle": not while typing; "empty": not
 * while typing, except in an empty field (⌥↑ moves the caret in text); "field": handled by the field itself.
 */
type When = "always" | "idle" | "empty" | "field";

export interface Shortcut {
  id: ShortcutId;
  label: string;
  group: "Загальне" | "Кімнати" | "Кімната" | "У полі";
  when: When;
  chord: Chord;
  /** Shown instead of the chord (a range like «1–9»). */
  text?: string;
}

// Picked around what the browser and the app already take: ⌘1…⌘9 switch browser tabs, so in a browser the
// views are ⌥⌘1/⌥⌘2 (Ctrl+Shift+1/2 off a Mac) and ⌘1/⌘2 only in the app, whose menus leave them free;
// ⌘\, ⌘J and ⌘. are free in the app's menus and the page takes them from the browser (Ctrl+J is Downloads
// on Windows). ⌥↑/⌥↓ stay the caret's while there is text to move in.
const view = (digit: "1" | "2"): Chord =>
  inApp ? { mod: true, code: `Digit${digit}`, label: digit } : isMac ? { mod: true, alt: true, code: `Digit${digit}`, label: digit } : { mod: true, shift: true, code: `Digit${digit}`, label: digit };

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette", label: "Пошук і всі дії", group: "Загальне", when: "always", chord: { mod: true, code: "KeyK", label: "K" } },
  { id: "settings", label: "Налаштування", group: "Загальне", when: "always", chord: { mod: true, code: "Comma", key: ",", label: "," } },
  { id: "keys", label: "Клавіші", group: "Загальне", when: "idle", chord: { shift: true, code: "Slash", key: "?", label: "?" } },
  { id: "compose", label: "До поля повідомлення", group: "Загальне", when: "idle", chord: { code: "Slash", key: "/", label: "/" } },
  { id: "close", label: "Закрити панель чи меню", group: "Загальне", when: "field", chord: { code: "Escape", label: "Esc" } },
  { id: "prevRoom", label: "Попередня кімната", group: "Кімнати", when: "empty", chord: { alt: true, code: "ArrowUp", label: "↑" } },
  { id: "nextRoom", label: "Наступна кімната", group: "Кімнати", when: "empty", chord: { alt: true, code: "ArrowDown", label: "↓" } },
  { id: "chat", label: "Розмова", group: "Кімната", when: "always", chord: view("1") },
  { id: "table", label: "Стіл", group: "Кімната", when: "always", chord: view("2") },
  { id: "panel", label: "Показати чи сховати панель", group: "Кімната", when: "always", chord: { mod: true, code: "Backslash", label: "\\" } },
  { id: "session", label: "Сесія агента", group: "Кімната", when: "always", chord: { mod: true, code: "KeyJ", label: "J" } },
  { id: "stop", label: "Зупинити агентів", group: "Кімната", when: "always", chord: { mod: true, code: "Period", label: "." } },
  { id: "send", label: "Надіслати", group: "У полі", when: "field", chord: { code: "Enter", label: "Enter" } },
  { id: "newline", label: "Новий рядок", group: "У полі", when: "field", chord: { shift: true, code: "Enter", label: "Enter" } },
  { id: "formSend", label: "Покласти на стіл з форми", group: "У полі", when: "field", chord: { mod: true, code: "Enter", label: "Enter" } },
  { id: "docSave", label: "Зберегти документ", group: "У полі", when: "field", chord: { mod: true, code: "KeyS", label: "S" } },
  { id: "modelDigit", label: "Модель у меню моделей", group: "У полі", when: "field", chord: { code: "Digit1", label: "1" }, text: "1–9" },
];

export const SHORTCUT = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s])) as Record<ShortcutId, Shortcut>;

/** "⌥⌘1" on a Mac, "Ctrl+Shift+1" elsewhere. */
export const chordLabel = ({ mod, alt, shift, label }: Chord) => {
  // "?" already is Shift+/: its Shift is not written.
  const withShift = shift && label !== "?";
  if (isMac) return `${alt ? "⌥" : ""}${withShift ? "⇧" : ""}${mod ? "⌘" : ""}${label === "Enter" ? "↵" : label}`;
  return [mod && "Ctrl", alt && "Alt", withShift && "Shift", label].filter(Boolean).join("+");
};

export const keyLabel = (id: ShortcutId) => SHORTCUT[id].text ?? chordLabel(SHORTCUT[id].chord);

/** The same for screen readers (aria-keyshortcuts): "Meta+Alt+1". */
export const ariaKeys = (id: ShortcutId) => {
  const { mod, alt, shift, label } = SHORTCUT[id].chord;
  return [mod && (isMac ? "Meta" : "Control"), alt && "Alt", shift && "Shift", label].filter(Boolean).join("+");
};

const hits = (event: KeyboardEvent, c: Chord) => {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  // The other of ⌘/Ctrl is never part of a chord here.
  const other = isMac ? event.ctrlKey : event.metaKey;
  if (mod !== Boolean(c.mod) || other || event.altKey !== Boolean(c.alt)) return false;
  if (c.key && event.key === c.key) return true;
  return event.code === c.code && event.shiftKey === Boolean(c.shift);
};

/** The page's shortcut this key press is, if any (keys a field handles itself are not the page's). */
export const shortcutOf = (event: KeyboardEvent): Shortcut | null => SHORTCUTS.find((s) => s.when !== "field" && hits(event, s.chord)) ?? null;
