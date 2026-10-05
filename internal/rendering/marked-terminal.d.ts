declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  export interface MarkedTerminalOptions {
    width?: number;
    reflowText?: boolean;
    tab?: number | string;
    heading?: (text: string) => string;
    firstHeading?: (text: string) => string;
    strong?: (text: string) => string;
    em?: (text: string) => string;
    codespan?: (text: string) => string;
    code?: (text: string) => string;
    blockquote?: (text: string) => string;
    html?: (text: string) => string;
    link?: (text: string) => string;
    href?: (text: string) => string;
    del?: (text: string) => string;
  }

  export function markedTerminal(options?: MarkedTerminalOptions): MarkedExtension;
}
