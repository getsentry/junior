import * as z from "zod";

// Slack limits set these values, so one request renders the same on every
// surface. Buttons and option text allow 75 characters. Radio buttons and
// checkboxes allow 10 options.
// https://docs.slack.dev/reference/block-kit/composition-objects/option-object
export const USER_INPUT_LIMITS = {
  maxButtonOptions: 5,
  maxDescriptionChars: 200,
  // A field's help text can hold a whole question. Slack allows 2,000
  // characters in an input hint.
  maxFieldDescriptionChars: 1_000,
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

function descriptionSchema(maxChars: number) {
  return z.string().trim().min(1).max(maxChars).optional();
}

const optionSchema = z.object({
  label: labelSchema,
  description: descriptionSchema(USER_INPUT_LIMITS.maxDescriptionChars),
  recommended: z.boolean().optional(),
});

const fieldBase = {
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: labelSchema,
  description: descriptionSchema(USER_INPUT_LIMITS.maxFieldDescriptionChars),
};

// A plugin item can have one choice, such as Resume, so a choice field can
// have one option.
const optionsSchema = z
  .array(optionSchema)
  .min(1)
  .max(USER_INPUT_LIMITS.maxOptions);

const userInputFieldSchema = z.discriminatedUnion("kind", [
  z.object({ ...fieldBase, kind: z.literal("choice"), options: optionsSchema }),
  z.object({
    ...fieldBase,
    kind: z.literal("multi_choice"),
    options: optionsSchema,
  }),
  z.object({ ...fieldBase, kind: z.literal("text") }),
]);

/**
 * A saved request: an optional question that its fields share, and the
 * fields. A question that an agent asks has no shared question: each field
 * holds its own question.
 */
export const savedUserInputRequestSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(USER_INPUT_LIMITS.maxQuestionChars)
      .optional(),
    fields: z
      .array(userInputFieldSchema)
      .min(1)
      .max(USER_INPUT_LIMITS.maxFields),
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
      if (
        field.kind === "choice" &&
        field.options.filter((option) => option.recommended).length > 1
      ) {
        context.addIssue({
          code: "custom",
          message: "A `choice` field can recommend only one option.",
        });
      }
    }
  });

/**
 * Label and help text of the free-text input that every form adds after the
 * fields. The text goes with the picked answers and does not replace them, so
 * every surface says that in the same words.
 */
export const USER_INPUT_NOTE = {
  label: "Anything else?",
  description: "Optional. This note is sent together with your answers above.",
} as const;

/** One field of a user input request. */
export type UserInputField = UserInputRequest["fields"][number];

/** A question with one or more fields for a person to answer. */
export type UserInputRequest = z.output<typeof savedUserInputRequestSchema>;

/**
 * A person's answer to one user input request. `values` maps field ids to
 * the picked option labels or the typed text. `other` is free text that the
 * person can always add.
 */
export interface UserInputAnswer {
  other?: string | undefined;
  requestId: string;
  values: Record<string, string[]>;
}

/**
 * Return the text that a request asks: its shared question, else the
 * question of each field, one paragraph each.
 */
export function userInputQuestionText(request: UserInputRequest): string {
  return (
    request.question ??
    request.fields.map((field) => field.description ?? field.label).join("\n\n")
  );
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

/**
 * Return the option labels that an answer picked, in field order. Text
 * fields and the note pick no option.
 */
export function answeredChoices(
  request: UserInputRequest,
  answer: UserInputAnswer,
): string[] {
  const { values } = normalizeUserInputAnswer(request, answer);
  return request.fields.flatMap((field) =>
    field.kind === "text" ? [] : (values[field.id] ?? []),
  );
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
 * Write the fields of an answer, one `Label (field_id): value` line each.
 * Slack, the web dashboard, and the prompt all use this text, so the model
 * reads one format.
 */
export function formatUserInputAnswer(
  request: UserInputRequest,
  answer: UserInputAnswer,
): string {
  const normalized = normalizeUserInputAnswer(request, answer);
  const lines: string[] = [];
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
