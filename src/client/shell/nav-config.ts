import { Boxes, Activity, Brain, Settings, FolderKanban } from "lucide-react";
import type { ComponentType } from "react";

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/** Primary destinations. Home (/home: what waits on you, and a composer that
 *  starts a thread) is not a row of its own: "New thread" opens it — two rows
 *  to one page read as a duplicate. */
export const navMain: NavItem[] = [
  { to: "/projects", label: "Projects", icon: FolderKanban },
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
