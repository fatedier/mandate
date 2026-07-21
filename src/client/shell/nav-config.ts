import { Boxes, Activity, Brain, Settings, House } from "lucide-react";
import type { ComponentType } from "react";

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/** Primary destinations. Home (= the mission-control projects page) keeps
 *  the /projects route — the path is a contract with the ui-routes skill. */
export const navMain: NavItem[] = [
  { to: "/projects", label: "Home", icon: House },
  { to: "/sessions", label: "Sessions", icon: Boxes }
];

/** Low-frequency management pages, rendered under a "System" group label. */
export const navSystem: NavItem[] = [
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/memory", label: "Memory", icon: Brain }
];

export const navSettings: NavItem = { to: "/settings", label: "Settings", icon: Settings };

/** Flat list for legacy consumers (section memory, etc.). */
export const navItems: NavItem[] = [...navMain, ...navSystem, navSettings];
