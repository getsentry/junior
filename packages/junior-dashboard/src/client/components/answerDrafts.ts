import * as z from "zod";

// Unsent answers by Inbox item id, so a form that unmounts (a row that
// collapses, a question that closes, a reload) shows them again when it
// mounts. The session store keeps them for the tab only.
const STORAGE_KEY = "junior:review-desk:answer-drafts";
// Drafts of items that closed while no form showed them stay until newer
// drafts push them out.
const MAX_DRAFTS = 50;

const draftSchema = z.object({
  custom: z.record(z.string(), z.string()).default({}),
  other: z.string(),
  values: z.record(z.string(), z.array(z.string())),
});
const draftsSchema = z.record(z.string(), draftSchema);

/**
 * Picks and own answers by field id, and the notes, that the reader has not
 * sent.
 */
export type AnswerDraft = z.output<typeof draftSchema>;

const EMPTY_DRAFT: AnswerDraft = { custom: {}, other: "", values: {} };

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
    Object.values(draft.custom).every((text) => !text) &&
    Object.values(draft.values).every((values) =>
      values.every((value) => !value),
    )
  );
}

/** Return the unsent answers of an Inbox item, or an empty draft. */
export function readAnswerDraft(itemId: string): AnswerDraft {
  return readDrafts()[itemId] ?? EMPTY_DRAFT;
}

/**
 * Save a change to the unsent answers of an Inbox item. The notes and the
 * fields that the change leaves out keep their saved value, so a second
 * form for the same item cannot write back its older picks. An empty
 * draft is removed.
 */
export function saveAnswerDraft(itemId: string, change: Partial<AnswerDraft>) {
  const drafts = readDrafts();
  const saved = drafts[itemId] ?? EMPTY_DRAFT;
  const draft = {
    custom: { ...saved.custom, ...change.custom },
    other: change.other ?? saved.other,
    values: { ...saved.values, ...change.values },
  };
  // Keep the newest drafts. Object keys keep their insertion order.
  const kept = Object.entries(drafts)
    .filter(([id]) => id !== itemId)
    .slice(1 - MAX_DRAFTS);
  writeDrafts(
    Object.fromEntries(isEmptyDraft(draft) ? kept : [...kept, [itemId, draft]]),
  );
}

/** Drop the unsent answers of an Inbox item that closed. */
export function clearAnswerDraft(itemId: string) {
  const drafts = readDrafts();
  if (!(itemId in drafts)) return;
  delete drafts[itemId];
  writeDrafts(drafts);
}
