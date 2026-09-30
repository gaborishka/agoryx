import { toast } from "sonner";
import { withMod } from "@/lib/keys";

export const copyText = async (text: string, select?: HTMLElement | null) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Скопійовано");
  } catch {
    if (select) {
      const range = document.createRange();
      range.selectNodeContents(select);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      toast(`Виділено — натисніть ${withMod("C")}`);
    } else toast.error("Не вдалося скопіювати");
  }
};
