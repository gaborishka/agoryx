// Shared by room routing and the composer: quoting someone is not addressing them.
const MENTION = /(^|[^\w@])@([a-z][\w-]{1,31})/gi;

export const parseMentions = (text: string, handles: string[]): string[] => {
  const known = new Set(handles.map((handle) => handle.toLowerCase()));
  const found = new Set<string>();
  // Every source line in a generated citation has >. Keep line breaks so removing a quote
  // cannot join two active tokens; Unicode separators within a quoted line stay quoted.
  const addressed = text.replace(/^[\t ]*>[^\r\n]*/gm, "");
  for (const match of addressed.matchAll(MENTION)) {
    const handle = match[2]!.toLowerCase();
    if (known.has(handle) || handle === "all") found.add(handle);
  }
  return [...found];
};
