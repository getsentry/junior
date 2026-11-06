import {
  Boxes,
  Brain,
  CodeXml,
  Gauge,
  Inbox,
  Zap,
  type LucideIcon,
} from "lucide-react";

// Plugin primary pages without an entry here use the generic plugin icon.
const NAV_ICONS: Record<string, LucideIcon> = {
  automations: Zap,
  code: CodeXml,
  "memory:memories": Brain,
  review: Inbox,
  system: Gauge,
};

/** Return the icon for a primary nav item key. */
export function navItemIcon(key: string): LucideIcon {
  return NAV_ICONS[key] ?? Boxes;
}
