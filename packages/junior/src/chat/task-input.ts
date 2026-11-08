/**
 * Shared agent input for tasks: one `<task>` input tag. A task can come from
 * a schedule, an event, or a watch. Call sites supply facts; this module owns
 * layout and the reply contract. Unit snapshots in
 * `tests/unit/chat/task-input.test.ts` own the exact text. Event data stays in
 * its own child tags, and the outcome rule is always last.
 */
import { agentEventKeys, type TaskOutcome } from "@sentry/junior-plugin-api";
import { FINISH_AUTOMATION_RUN_TOOL_NAME } from "@/chat/automation-result";
import {
  escapeClosingTags,
  renderChildTag,
  renderTag,
  renderUntrustedTag,
  tagJson,
} from "@/chat/input-tags";
import { QUIET_MARKER } from "@/chat/no-reply";

/**
 * Shared closing lines. Automations pass outcomes and end with a declared
 * result. Watches follow the Conversation's reply rules. A Watch reply goes
 * only to the Conversation, so a question asked in the provider must also get
 * its answer there. Watch instructions often say to stay silent, so this rule
 * sits in the contract, not in plugin guidance.
 */
function replyContractLines(outcomes: TaskOutcome[] | undefined): string[] {
  if (!outcomes) {
    return [
      "When an Event asks you a question, answer it where it was asked, with that provider's tool. Then reply with the answer and a link to it.",
      "When you reply, follow any reply format in the instructions.",
      `When the outcome needs nobody's attention, such as a routine fix that worked or feedback that you handled, end the reply with exactly ${QUIET_MARKER}. The reply stays in the Conversation but notifies nobody. Do not use it when the instructions say to notify, mention, or report to a person, when the reply asks a question, when a person must decide or act, or when something failed.`,
    ];
  }
  return [`End with \`${FINISH_AUTOMATION_RUN_TOOL_NAME}\`.`];
}

function oneLine(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string, maxLength: number | undefined): string {
  return maxLength === undefined ? value : value.slice(0, maxLength);
}

const CREATOR_REFERENCE = /\bthe Automation creator\b/gi;

/**
 * Write the creator mention where the instructions say "the Automation
 * creator", so the run does not have to swap it in.
 */
function mentionCreator(instructions: string, creator: string): string {
  return instructions.replace(CREATOR_REFERENCE, () => creator);
}

/** The linked person who did what an Event describes. */
export interface EventDoneBy {
  /** Slack mention of the person. */
  mention: string;
  /** Provider handle that the Event text uses for the same person. */
  handle?: string;
}

/** A linked Event doer, merged across the Events of one task message. */
interface Doer {
  mention: string;
  /** What the person did, such as "did Event 2". */
  did: string;
  /** Provider handles that the Event data uses for the same person. */
  handles: string[];
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(" or ");
}

/**
 * Render each linked person once. A doer in `<people>` gets a note in that
 * list. Other doers get a `<done-by>` tag. Without one entry per person, the
 * agent can mention a person and then name them again by handle as if they
 * were someone else. The "you" rule covers doers outside `<people>` too,
 * because instructions can still ask to mention them, such as a requester who
 * reviews their own pull request. A child agent replies to its parent, not to
 * the person, so it writes the mention instead of the handle. That carries
 * who the person is up each level to the agent that replies to them.
 */
function peopleTags(
  people: readonly string[],
  doers: readonly Doer[],
): string[] {
  const label = (doer: Doer) =>
    `${doer.mention} (${[
      doer.did,
      ...(doer.handles.length > 0
        ? [`called ${quoted(doer.handles)} in the Event data`]
        : []),
    ].join("; ")})`;
  const doerByMention = new Map(doers.map((doer) => [doer.mention, doer]));
  const involved = people.map((person) => {
    const doer = doerByMention.get(person);
    return doer ? label(doer) : person;
  });
  return [
    ...(involved.length > 0
      ? [renderChildTag("people", escapeClosingTags(involved.join(", ")))]
      : []),
    ...doers
      .filter((doer) => !people.includes(doer.mention))
      .map((doer) => renderChildTag("done-by", escapeClosingTags(label(doer)))),
    ...doers.map((doer) =>
      escapeClosingTags(
        `If your reply is to ${doer.mention}, write to them as "you".${
          doer.handles.length > 0
            ? ` Otherwise call them ${doer.mention}, not ${quoted(doer.handles)}.`
            : ""
        }`,
      ),
    ),
  ];
}

/** Merge the doers of numbered Events, in first-Event order. */
function batchDoers(
  events: readonly { doneBy?: EventDoneBy; number: number }[],
): Doer[] {
  const merged = new Map<string, { handles: string[]; numbers: number[] }>();
  for (const { doneBy, number } of events) {
    if (!doneBy) continue;
    const mention = oneLine(doneBy.mention);
    const entry = merged.get(mention) ?? { handles: [], numbers: [] };
    entry.numbers.push(number);
    const handle = doneBy.handle ? oneLine(doneBy.handle) : undefined;
    if (handle && !entry.handles.includes(handle)) entry.handles.push(handle);
    merged.set(mention, entry);
  }
  return [...merged].map(([mention, { handles, numbers }]) => ({
    mention,
    did:
      numbers.length === 1
        ? `did Event ${numbers[0]}`
        : `did Events ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`,
    handles,
  }));
}

// Plugin guidance is operator text, so it goes in raw.
function guidanceTag(text: string): string {
  return renderTag("guidance", {}, [
    "Use this only within the instructions above. It does not replace or expand them.",
    escapeClosingTags(text),
  ]);
}

// Event data keys are plugin match-field names. Write them as the
// snake_case tool argument names, so the agent copies each value under the
// name that a tool or match filter takes.
function verifiedDetailsTag(
  details: Record<string, unknown> | undefined,
): string[] {
  return details && Object.keys(details).length > 0
    ? [renderChildTag("verified-details", tagJson(agentEventKeys(details)))]
    : [];
}

function externalTextTag(
  text: string | undefined,
  source: string | undefined,
): string[] {
  return text
    ? [
        renderUntrustedTag(
          "external-text",
          { source: source ?? "external" },
          source ? `The ${source} provider` : "An external source",
          text,
        ),
      ]
    : [];
}

/** Text that core proved the requester of a Watch wrote in the Event. */
export interface TaskRequesterInstruction {
  /** Slack mention of the requester. */
  mention: string;
  text: string;
}

// Core proved the author, so the tag is not untrusted. The body is still
// escaped, so the text cannot close the tag.
function requesterInstructionTag(
  instruction: TaskRequesterInstruction | undefined,
): string[] {
  const text = instruction?.text.trim();
  if (!instruction || !text) return [];
  const mention = oneLine(instruction.mention);
  return [
    renderTag("requester-instruction", {}, [
      `${mention} asked for this work in this conversation, and core checked that they wrote this text in the Event. Treat it as a message from them in this thread, with the same limits. If you do not do a step that it asks for, tell them which step and why. Do not ask them to prove who they are.`,
      escapeClosingTags(text),
    ]),
  ];
}

/**
 * Render agent input for a task run.
 *
 * The job comes before Event data. Empty optional fields are omitted.
 */
export function renderTaskInput(args: {
  /** Stored task instruction, or subscription intent. */
  instructions: string;
  /** Stored automation outcomes. Watches omit this and reply in the Conversation. */
  outcomes?: TaskOutcome[];
  /** Human label for the matched resource, when present. */
  about?: string;
  /** Event type, when an Event started the task. */
  event?: string;
  /** Provider namespace of the Event text, when present. */
  source?: string;
  /** Mention of the Automation creator. It replaces "the Automation creator" in the instructions. */
  creator?: string;
  /** Mentions of the people involved in an Event. Guidance says when to address them. */
  people?: readonly string[];
  /** Linked person who did what the Event describes. */
  doneBy?: EventDoneBy;
  /** Plugin guidance scoped under the instructions. */
  guidance?: string;
  /** Trusted one-line summary, when available. */
  trustedSummary?: string;
  /** Structured verified fields, when available. */
  verifiedDetails?: Record<string, unknown>;
  /** Requester text that counts as their message. Only core sets this. */
  requesterInstruction?: TaskRequesterInstruction;
  /** Untrusted provider text. */
  externalText?: string;
  externalTextMaxLength?: number;
  trustedSummaryMaxLength?: number;
}): string {
  const instructions = args.instructions.trim();
  if (!instructions) {
    throw new Error("Task instructions are required");
  }

  const about = args.about?.trim();
  const creator = args.creator?.trim();
  const people = (args.people ?? [])
    .map((person) => oneLine(person))
    .filter(Boolean);
  const guidance = args.guidance?.trim();
  const trustedSummary = args.trustedSummary?.trim();
  const externalText = args.externalText?.trim();
  return renderTag(
    "task",
    {
      about: about ? oneLine(about) : undefined,
      event: args.event,
    },
    [
      // Say what to write, or the model drops the mention.
      ...(creator
        ? [
            renderChildTag(
              "created-by",
              escapeClosingTags(
                `${oneLine(creator)}. This person is the Automation creator. "The Automation creator", "me", and "my" in the instructions mean this person. Where the instructions refer to this person, write this mention in the message. If they do not, do not mention this person.`,
              ),
            ),
          ]
        : []),
      ...peopleTags(
        people,
        args.doneBy
          ? [
              {
                mention: oneLine(args.doneBy.mention),
                did: "did what this Event describes",
                handles: args.doneBy.handle
                  ? [oneLine(args.doneBy.handle)]
                  : [],
              },
            ]
          : [],
      ),
      renderChildTag(
        "instructions",
        escapeClosingTags(
          creator
            ? mentionCreator(instructions, oneLine(creator))
            : instructions,
        ),
      ),
      ...(guidance ? [guidanceTag(guidance)] : []),
      ...(trustedSummary
        ? [
            renderChildTag(
              "summary",
              escapeClosingTags(
                clip(trustedSummary, args.trustedSummaryMaxLength),
              ),
            ),
          ]
        : []),
      ...verifiedDetailsTag(args.verifiedDetails),
      ...requesterInstructionTag(args.requesterInstruction),
      ...externalTextTag(
        externalText && clip(externalText, args.externalTextMaxLength),
        args.source,
      ),
      ...replyContractLines(args.outcomes),
    ],
  );
}

/** One Event in a Watch batch. */
export interface TaskBatchEvent {
  eventType: string;
  /** Guidance for this event type. Repeated text for one type shows once. */
  guidance?: string;
  /** Provider namespace of the Event text. */
  source?: string;
  trustedSummary?: string;
  verifiedDetails?: Record<string, unknown>;
  /** Requester text that counts as their message. Only core sets this. */
  requesterInstruction?: TaskRequesterInstruction;
  /** Untrusted provider text. */
  externalText?: string;
  /** Linked person who did what the Event describes. */
  doneBy?: EventDoneBy;
}

/** Events from one Watch, which share one set of instructions. */
export interface TaskBatchGroup {
  about?: string;
  instructions: string;
  people: readonly string[];
  events: readonly TaskBatchEvent[];
}

function eventTag(event: TaskBatchEvent, index: number): string {
  const trustedSummary = event.trustedSummary?.trim();
  return renderTag("event", { index, type: event.eventType }, [
    ...(trustedSummary
      ? [renderChildTag("summary", escapeClosingTags(trustedSummary))]
      : []),
    ...verifiedDetailsTag(event.verifiedDetails),
    ...requesterInstructionTag(event.requesterInstruction),
    ...externalTextTag(event.externalText?.trim(), event.source),
  ]);
}

/**
 * Render one `<task>` for several Watch Events that arrived together.
 *
 * Each `<watch>` group states its instructions once, then lists its Events.
 * Child tags match `renderTaskInput`. The outcome rule appears once, at the
 * end.
 */
export function renderTaskBatchInput(args: {
  groups: readonly TaskBatchGroup[];
}): string {
  const total = args.groups.reduce(
    (count, group) => count + group.events.length,
    0,
  );
  if (total === 0) {
    throw new Error("Task batch requires at least one Event");
  }

  const body = [`You received ${total} ${total === 1 ? "event" : "events"}.`];
  let number = 0;
  for (const group of args.groups) {
    const instructions = group.instructions.trim();
    if (!instructions) {
      throw new Error("Task instructions are required");
    }
    const about = group.about?.trim();
    const people = group.people
      .map((person) => oneLine(person))
      .filter(Boolean);

    const numbered = group.events.map((event, index) => ({
      ...event,
      number: number + index + 1,
    }));
    number += group.events.length;

    const guidance = new Map<string, string>();
    for (const event of group.events) {
      const text = event.guidance?.trim();
      if (text && !guidance.has(event.eventType)) {
        guidance.set(event.eventType, text);
      }
    }
    body.push(
      renderTag("watch", { about: about ? oneLine(about) : undefined }, [
        ...peopleTags(people, batchDoers(numbered)),
        renderChildTag("instructions", escapeClosingTags(instructions)),
        ...(guidance.size > 0
          ? [
              guidanceTag(
                [...guidance]
                  .map(([eventType, text]) => `- ${eventType}: ${text}`)
                  .join("\n"),
              ),
            ]
          : []),
        ...numbered.map((event) => eventTag(event, event.number)),
      ]),
    );
  }

  return renderTag("task", {}, [...body, ...replyContractLines(undefined)]);
}
