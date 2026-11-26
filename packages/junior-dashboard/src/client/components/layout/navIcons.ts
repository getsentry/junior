import {
  Boxes,
  Brain,
  CircleCheck,
  Clock3,
  CodeXml,
  Gauge,
  Inbox,
  MessageCircleQuestion,
  MessagesSquare,
  Settings,
  ShieldCheck,
  UserRound,
  Zap,
  type LucideIcon,
} from "lucide-react";

// Plugin pages without an entry here use the generic plugin icon.
const NAV_ICONS: Record<string, LucideIcon> = {
  admin: ShieldCheck,
  automations: Zap,
  code: CodeXml,
  conversations: MessagesSquare,
  decisions: MessageCircleQuestion,
  done: CircleCheck,
  inbox: Inbox,
  "memory:memories": Brain,
  "my-profile": UserRound,
  settings: Settings,
  snoozed: Clock3,
  system: Gauge,
};

/** Return the icon for a nav item key. */
export function navItemIcon(key: string): LucideIcon {
  return NAV_ICONS[key] ?? Boxes;
}
