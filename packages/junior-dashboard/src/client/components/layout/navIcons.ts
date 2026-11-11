import {
  Boxes,
  Brain,
  CodeXml,
  Gauge,
  Inbox,
  Zap,
  type LucideIcon,
} from "lucide-react";

// Plugin pages without an entry here use the generic plugin icon.
const NAV_ICONS: Record<string, LucideIcon> = {
  automations: Zap,
  code: CodeXml,
  inbox: Inbox,
  "memory:memories": Brain,
  system: Gauge,
};

/** Return the icon for a nav item key. */
export function navItemIcon(key: string): LucideIcon {
  return NAV_ICONS[key] ?? Boxes;
}
