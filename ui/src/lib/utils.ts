import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Our named type steps and the reading width (index.css @theme): without them tailwind-merge would take
// `text-small` for a colour and drop it next to `text-muted-foreground`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["micro", "meta", "small", "ui", "body", "lead", "title", "display"],
      container: ["reading"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
