import { create } from "zustand";
import { local } from "./api";

export type ThemePref = "system" | "light" | "dark";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const read = (): ThemePref => {
  const v = local.get("theme");
  return v === "light" || v === "dark" ? v : "system";
};
const resolve = (pref: ThemePref) => (pref === "system" ? (media.matches ? "dark" : "light") : pref);

export const useTheme = create<{ pref: ThemePref; dark: boolean; cycle: () => void }>((set, get) => ({
  pref: read(),
  dark: resolve(read()) === "dark",
  cycle() {
    const order: ThemePref[] = ["system", "light", "dark"];
    const pref = order[(order.indexOf(get().pref) + 1) % order.length]!;
    local.set("theme", pref === "system" ? null : pref);
    set({ pref, dark: resolve(pref) === "dark" });
    paint();
  },
}));

const paint = () => document.documentElement.classList.toggle("dark", useTheme.getState().dark);
media.addEventListener("change", () => {
  useTheme.setState({ dark: resolve(useTheme.getState().pref) === "dark" });
  paint();
});
paint();

export const THEME_LABEL: Record<ThemePref, string> = {
  system: "Тема як у системі",
  light: "Світла тема",
  dark: "Темна тема",
};
