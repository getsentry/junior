import type { ConversationTodo } from "@sentry/junior/api/schema";
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  type LucideIcon,
} from "lucide-react";

/** The icon of each To-do status, wherever a To-do shows. */
export const todoStatusIcons: Record<ConversationTodo["status"], LucideIcon> = {
  open: Circle,
  in_progress: CircleDashed,
  done: CircleCheck,
  dropped: CircleX,
};
