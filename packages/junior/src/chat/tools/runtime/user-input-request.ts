import { z } from "zod";

// Slack limits set these values, so one request renders the same on every
// surface. Buttons and option text allow 75 characters. Radio buttons and
// checkboxes allow 10 options.
// https://docs.slack.dev/reference/block-kit/composition-objects/option-object
export const USER_INPUT_LIMITS = {
  maxButtonOptions: 5,
  maxDescriptionChars: 200,
  maxFields: 4,
  maxLabelChars: 75,
  maxOptions: 10,
  maxTextChars: 3_000,
  maxQuestionChars: 3_000,
  minOptions: 2,
} as const;

const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(USER_INPUT_LIMITS.maxLabelChars);
const descriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(USER_INPUT_LIMITS.maxDescriptionChars)
  .optional();

const optionSchema = z.object({
  label: labelSchema.describe(
    "Short choice text, such as `Accept` or `Decline`. The answer uses this exact text.",
  ),
  description: descriptionSchema.describe(
    "Optional short note about what this choice does.",
  ),
});

const fieldBase = {
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .describe("Stable key for this field, such as `approach`."),
  label: labelSchema.describe("Short field name, such as `Approach`."),
  description: descriptionSchema.describe(
    "Optional short help text for this field.",
  ),
};

const optionsSchema = z
  .array(optionSchema)
  .min(USER_INPUT_LIMITS.minOptions)
  .max(USER_INPUT_LIMITS.maxOptions)
  .describe("Choices in display order.");

const userInputFieldSchema = z.discriminatedUnion("kind", [
  z.object({
    ...fieldBase,
    kind: z.literal("choice").describe("The person picks one option."),
    options: optionsSchema,
  }),
  z.object({
    ...fieldBase,
    kind: z
      .literal("multi_choice")
      .describe("The person picks any number of options."),
    options: optionsSchema,
  }),
  z.object({
    ...fieldBase,
    kind: z.literal("text").describe("The person types a short answer."),
  }),
]);

export const userInputRequestSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(USER_INPUT_LIMITS.maxQuestionChars)
      .describe(
        "The question, in markdown. Include the facts the person needs to decide.",
      ),
    fields: z
      .array(userInputFieldSchema)
      .min(1)
      .max(USER_INPUT_LIMITS.maxFields)
      .describe(
        "What to ask, in display order. Use one `choice` field for a simple decision.",
      ),
  })
  .superRefine((request, context) => {
    const ids = new Set<string>();
    for (const field of request.fields) {
      if (ids.has(field.id)) {
        context.addIssue({
          code: "custom",
          message: "Each field needs a different id.",
        });
      }
      ids.add(field.id);
      if (field.kind === "text") continue;
      const labels = field.options.map((option) => option.label.toLowerCase());
      if (new Set(labels).size !== labels.length) {
        context.addIssue({
          code: "custom",
          message: "Each choice of a field needs a different label.",
        });
      }
    }
  });

/** One field of a user input request. */
export type UserInputField = z.output<typeof userInputFieldSchema>;

/** A question with one or more fields for a person to answer. */
export type UserInputRequest = z.output<typeof userInputRequestSchema>;

/**
 * A person's answer to one user input request. `values` maps field ids to
 * the picked option labels or the typed text. `other` is free text that the
 * person can always add.
 */
export interface UserInputAnswer {
  other?: string;
  requestId: string;
  values: Record<string, string[]>;
}

/**
 * Return the single choice field of a request that a surface can show as
 * one row of buttons, where one click is the whole answer.
 */
export function buttonUserInputField(
  request: UserInputRequest,
): Extract<UserInputField, { kind: "choice" }> | undefined {
  const [field, ...rest] = request.fields;
  if (rest.length || field?.kind !== "choice") return undefined;
  return field.options.length <= USER_INPUT_LIMITS.maxButtonOptions
    ? field
    : undefined;
}

/**
 * Keep only answer values that match the request: known field ids, known
 * option labels, one value for a `choice` field, and trimmed text.
 */
export function normalizeUserInputAnswer(
  request: UserInputRequest,
  answer: UserInputAnswer,
): UserInputAnswer {
  const values: Record<string, string[]> = {};
  for (const field of request.fields) {
    const raw = (answer.values[field.id] ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
    if (field.kind === "text") {
      const text = raw.join("\n").slice(0, USER_INPUT_LIMITS.maxTextChars);
      if (text) values[field.id] = [text];
      continue;
    }
    const picked = field.options
      .map((option) => option.label)
      .filter((label) => raw.includes(label));
    const kept = field.kind === "choice" ? picked.slice(0, 1) : picked;
    if (kept.length) values[field.id] = kept;
  }
  const other = answer.other?.trim().slice(0, USER_INPUT_LIMITS.maxTextChars);
  return {
    requestId: answer.requestId,
    values,
    ...(other ? { other } : undefined),
  };
}

/** Return true when an answer has no value and no free text. */
export function isEmptyUserInputAnswer(answer: UserInputAnswer): boolean {
  return !answer.other && Object.keys(answer.values).length === 0;
}

// Slack parses input text as mrkdwn, which drops list markers and blank
// lines. Plain lines keep the same text on every surface. Split instead of a
// regular expression, so long runs of spaces cannot make this slow.
function answerLine(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Write an answer as the text of the person's message. Slack and the web
 * dashboard both send this text, so the model reads one format. The first
 * line names the request, and each field starts its own line.
 */
export function formatUserInputAnswer(
  request: UserInputRequest,
  answer: UserInputAnswer,
): string {
  const normalized = normalizeUserInputAnswer(request, answer);
  const lines = [`Answer to request ${normalized.requestId}:`];
  for (const field of request.fields) {
    const values = normalized.values[field.id];
    const value = values?.length ? values.join(", ") : "(no answer)";
    lines.push(answerLine(`${field.label} (${field.id}): ${value}`));
  }
  if (normalized.other) {
    lines.push(answerLine(`Other: ${normalized.other}`));
  }
  return lines.join("\n");
}
