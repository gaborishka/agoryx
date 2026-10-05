import { Marked } from "marked";
import { createColors } from "picocolors";
import { markedTerminal } from "marked-terminal";

const DEFAULT_WIDTH = 100;
const ansi = createColors(true);

const createRendererOptions = (width: number) => ({
  width,
  reflowText: true,
  tab: 2,
  heading: (text: string) => ansi.bold(ansi.green(text)),
  firstHeading: (text: string) => ansi.bold(ansi.underline(ansi.magenta(text))),
  strong: (text: string) => ansi.bold(text),
  em: (text: string) => ansi.italic(text),
  codespan: (text: string) => ansi.yellow(text),
  code: (text: string) => ansi.yellow(text),
  blockquote: (text: string) => ansi.italic(ansi.gray(text)),
  html: (text: string) => ansi.gray(text),
  link: (text: string) => ansi.blue(text),
  href: (text: string) => ansi.underline(ansi.blue(text)),
  del: (text: string) => ansi.dim(ansi.gray(ansi.strikethrough(text))),
});

const createRenderer = (width: number): Marked => {
  const instance = new Marked();
  instance.use(markedTerminal(createRendererOptions(width)));
  return instance;
};

export const renderMarkdownToAnsi = (
  text: string,
  width = DEFAULT_WIDTH,
): string => {
  const renderer = createRenderer(width);
  const result = renderer.parse(text);
  if (typeof result !== "string") {
    return text;
  }
  return result.trimEnd();
};
