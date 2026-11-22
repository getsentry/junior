import { findLegacyNoReplyMarker } from "@/chat/no-reply";
import { slackMention } from "@/chat/slack/mrkdwn";
import { AutomationEditError } from "./edit-rules";
import { automationTaskText, type AutomationTask } from "./task";

/** A person account in the workspace of the Automation Destination. */
type InstructionPerson = { slackUserId: string; fullName?: string | undefined };

function namesPerson(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(text);
}

const CONVERSATION_REFERENCE = /\bthis (?:channel|conversation|thread)\b/i;
const FIRST_PERSON_WORDS = ["me", "my", "myself"] as const;

function wordCount(text: string, word: string): number {
  return text.match(new RegExp(`\\b${word}\\b`, "gi"))?.length ?? 0;
}

/**
 * Return a first-person word that the text uses more often than the previous
 * text, or undefined. A creator's "my" that the edit keeps stays allowed, but
 * a new "me" next to it does not.
 */
function addedFirstPerson(text: string, previousText: string) {
  return FIRST_PERSON_WORDS.find(
    (word) => wordCount(text, word) > wordCount(previousText, word),
  );
}

function refersTo(text: string, person: InstructionPerson): boolean {
  return (
    text.includes(slackMention(person.slackUserId)) ||
    (!!person.fullName && namesPerson(text, person.fullName))
  );
}

/**
 * Return why the text cannot run later, or undefined.
 *
 * An Automation runs later without the request. So "this channel" means
 * nothing to the run. Its outcomes already say where it posts, so the text
 * names the channel only where the run reads or acts on it. Each run reads
 * "the Automation creator" as its creator, so the text calls the creator
 * that. Every other requester needs their Slack mention, because a display
 * name does not notify the person and it can match another person. Their
 * "me" needs it too, because each run reads "me" as the creator. A run
 * ends with `reply`, `noReply`, or `reportBlocked`, so a legacy no-reply
 * marker does nothing. A problem that the previous text already had stays
 * allowed, so an edit does not have to rewrite text that the requester did
 * not change.
 */
function taskTextProblem(
  text: string,
  references: {
    creator: InstructionPerson;
    requester?: InstructionPerson | undefined;
    previousText: string;
    /** "instruction" or "context". */
    label: string;
  },
): string | undefined {
  const { creator, requester, previousText, label } = references;
  const conversationReference = CONVERSATION_REFERENCE.exec(text)?.[0];
  if (conversationReference && !CONVERSATION_REFERENCE.test(previousText)) {
    return `The run does not see this conversation, and its outcomes already set where it posts. Remove "${conversationReference}" and do not say where to post. Where the run reads or changes a channel, name it with a channel mention.`;
  }
  const marker = findLegacyNoReplyMarker(text);
  if (marker && !previousText.includes(marker)) {
    return `Remove "${marker}". Say when the run posts nothing; it then ends without a message.`;
  }
  if (refersTo(text, creator) && !refersTo(previousText, creator)) {
    const reference = creator.fullName ?? slackMention(creator.slackUserId);
    return `The ${label} names ${reference}, the Automation creator. Write "the Automation creator" for this person; each run knows who that is.`;
  }
  if (!requester || requester.slackUserId === creator.slackUserId) {
    return undefined;
  }
  const mention = slackMention(requester.slackUserId);
  const firstPerson = addedFirstPerson(text, previousText);
  if (firstPerson) {
    return `The ${label} says "${firstPerson}", and each run reads that as the Automation creator. Write ${mention} for the requester.`;
  }
  if (
    !requester.fullName ||
    text.includes(mention) ||
    !namesPerson(text, requester.fullName)
  ) {
    return undefined;
  }
  return `The ${label} names ${requester.fullName} without a Slack mention. Write ${mention} for this person.`;
}

/** People and the saved task that the task text checks compare against. */
type TaskTextReferences = {
  creator: InstructionPerson;
  /** The person who edits the task, when it is not a new Automation. */
  requester?: InstructionPerson | undefined;
  /** The task before this edit. Unset for a new Automation. */
  current?: AutomationTask | undefined;
};

function previousTaskText(current: AutomationTask | undefined): string {
  return (current && automationTaskText(current)) ?? "";
}

/**
 * Return why each task text of an Automation tool call cannot run later.
 * The tools check every text field, also when the fields do not form a
 * valid task, so that one rejection names every problem of the call.
 */
export function automationTaskTextProblems(
  texts: {
    instruction?: string | undefined;
    context?: string | null | undefined;
  },
  references: TaskTextReferences,
): string[] {
  const previousText = previousTaskText(references.current);
  const problems: string[] = [];
  for (const label of ["instruction", "context"] as const) {
    const text = texts[label];
    if (!text || text === previousText) continue;
    const problem = taskTextProblem(text, {
      ...references,
      previousText,
      label,
    });
    if (problem) problems.push(problem);
  }
  return problems;
}

/**
 * Reject task text that a later run cannot use. The dashboard edit API calls
 * this. Restoring a saved version does not, because that text was accepted
 * when it was saved. Text that the current task already had is not checked
 * again.
 */
export function requireAutomationTaskText(
  task: AutomationTask,
  references: TaskTextReferences,
): void {
  const text = automationTaskText(task);
  const previousText = previousTaskText(references.current);
  if (text === undefined || text === previousText) return;
  const label = task.kind === "instruction" ? "instruction" : "context";
  const problem = taskTextProblem(text, { ...references, previousText, label });
  if (problem) throw new AutomationEditError(problem, `task.${label}`);
}
