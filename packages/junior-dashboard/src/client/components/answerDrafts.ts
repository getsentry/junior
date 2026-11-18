import * as z from "zod";

// Unsent answers by Review item id, so a form that unmounts (a row that
// collapses, a question that closes, a reload) shows them again when it
// mounts. The session store keeps them for the tab only.
const STORAGE_KEY = "junior:review-desk:answer-drafts";
// Drafts of items that closed while no form showed them stay until newer
// drafts push them out.
const MAX_DRAFTS = 50;

const draftSchema = z.object({
  other: z.string(),
  values: z.record(z.string(), z.array(z.string())),
});
const draftsSchema = z.record(z.string(), draftSchema);

/** Picks by field id, and the note, that the reader has not sent. */
export type AnswerDraft = z.infer<typeof draftSchema>;

const EMPTY_DRAFT: AnswerDraft = { other: "", values: {} };

function readDrafts(): Record<string, AnswerDraft> {
  try {
    const parsed = draftsSchema.safeParse(
      JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}"),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    // Without the store, answers still hold while the form shows.
    return {};
  }
}

function writeDrafts(drafts: Record<string, AnswerDraft>) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Without the store, answers still hold while the form shows.
  }
}

function isEmptyDraft(draft: AnswerDraft): boolean {
  return (
    !draft.other &&
    Object.values(draft.values).every((values) =>
      values.every((value) => !value),
    )
  );
}

/** Return the unsent answers of a Review item, or an empty draft. */
export function readAnswerDraft(itemId: string): AnswerDraft {
  return readDrafts()[itemId] ?? EMPTY_DRAFT;
}

/**
 * Save a change to the unsent answers of a Review item. Parts that the
 * change leaves out keep their saved value. An empty draft is removed.
 */
export function saveAnswerDraft(itemId: string, change: Partial<AnswerDraft>) {
  const drafts = readDrafts();
  const draft = { ...(drafts[itemId] ?? EMPTY_DRAFT), ...change };
  // Keep the newest drafts. Object keys keep their insertion order.
  const kept = Object.entries(drafts)
    .filter(([id]) => id !== itemId)
    .slice(1 - MAX_DRAFTS);
  writeDrafts(
    Object.fromEntries(isEmptyDraft(draft) ? kept : [...kept, [itemId, draft]]),
  );
}

/** Drop the unsent answers of a Review item that closed. */
export function clearAnswerDraft(itemId: string) {
  const drafts = readDrafts();
  if (!(itemId in drafts)) return;
  delete drafts[itemId];
  writeDrafts(drafts);
}
