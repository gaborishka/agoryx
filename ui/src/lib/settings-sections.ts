import { BotIcon, GaugeIcon, InfoIcon, SlidersHorizontalIcon, SmartphoneIcon, UserRoundIcon, type LucideIcon } from "lucide-react";
import type { SettingsSection } from "./store";

/** Shared by the contextual sidebar and the settings page breadcrumb. */
export const SETTINGS_NAVIGATION: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "profile", label: "Profile", icon: UserRoundIcon },
  { id: "agents", label: "Agents", icon: BotIcon },
  { id: "phone", label: "Phone", icon: SmartphoneIcon },
  { id: "limits", label: "Limits", icon: GaugeIcon },
  { id: "about", label: "About Agoryx", icon: InfoIcon },
];
