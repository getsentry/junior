import * as z from "zod";
import { TODO_STATUSES } from "@/chat/todos/types";

/** The sources that `/api/search` can search. */
const SEARCH_SOURCES = [
  "inboxItems",
  "automations",
  "memories",
  "todos",
] as const;

/** One source of `/api/search`. */
export type SearchSource = (typeof SEARCH_SOURCES)[number];

/**
 * A search while a person types. `sources` names the groups to search,
 * comma separated, such as `inboxItems,automations`.
 */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100),
    sources: z
      .string()
      .transform((value) => [...new Set(value.split(","))])
      .pipe(z.array(z.enum(SEARCH_SOURCES)).min(1)),
  })
  .strict();

/** An Inbox item that matches a search. */
export const searchInboxItemSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["open", "done", "dismissed"]),
    title: z.string(),
  })
  .strict();

/** An Automation that matches a search. */
export const searchAutomationSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["scheduled", "event"]),
    status: z.enum(["active", "blocked", "paused", "completed"]),
    title: z.string(),
  })
  .strict();

/** A memory that matches a search, its text cut to one menu row. */
export const searchMemorySchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
  })
  .strict();

/** A To-do that matches a search, in a Conversation that shows its title. */
export const searchTodoSchema = z
  .object({
    conversationId: z.string().min(1),
    id: z.number().int(),
    status: z.enum(TODO_STATUSES),
    title: z.string(),
  })
  .strict();

/** One group of matches for each source that the search named. */
export const searchReportSchema = z
  .object({
    automations: z.array(searchAutomationSchema).optional(),
    inboxItems: z.array(searchInboxItemSchema).optional(),
    memories: z.array(searchMemorySchema).optional(),
    todos: z.array(searchTodoSchema).optional(),
  })
  .strict();

export type SearchAutomation = z.infer<typeof searchAutomationSchema>;
export type SearchInboxItem = z.infer<typeof searchInboxItemSchema>;
export type SearchMemory = z.infer<typeof searchMemorySchema>;
export type SearchTodo = z.infer<typeof searchTodoSchema>;
export type SearchReport = z.infer<typeof searchReportSchema>;
