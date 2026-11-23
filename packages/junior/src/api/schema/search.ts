import * as z from "zod";

/** The sources that `/api/search` can search. */
const SEARCH_SOURCES = ["inboxItems", "automations"] as const;

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

/** One group of matches for each source that the search named. */
export const searchReportSchema = z
  .object({
    automations: z.array(searchAutomationSchema).optional(),
    inboxItems: z.array(searchInboxItemSchema).optional(),
  })
  .strict();

export type SearchAutomation = z.infer<typeof searchAutomationSchema>;
export type SearchInboxItem = z.infer<typeof searchInboxItemSchema>;
export type SearchReport = z.infer<typeof searchReportSchema>;
