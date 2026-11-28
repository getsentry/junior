/**
 * The input of the tools that ask a person questions, and the content that
 * a question stores from it.
 */
import * as z from "zod";
import { parseToolInput } from "@/chat/tool-support/zod-tool";
import { inboxItemRequestSchema } from "./request";
import { USER_INPUT_LIMITS, type UserInputField } from "./user-input-request";
import type { QuestionContent } from "./store";

/** Who is asked. */
export const assigneesSchema = z
  .array(z.string().trim().min(1).max(320))
  .min(1)
  .max(20)
  .describe(
    "Who can act on the item. Each entry is `everyone`, an email, or a mention such as `<@U123>`. Everyone means any person who can see the item.",
  );

const RECOMMENDED_SUFFIX = /\s*\(recommended\)$/i;
// The Inbox row shows the title, so it stays short.
const MAX_TITLE_CHARS = 200;

const questionOptionSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(USER_INPUT_LIMITS.maxLabelChars)
      .describe(
        "The choice the person picks, 1-5 words. The answer uses this text.",
      ),
    description: z
      .string()
      .trim()
      .min(1)
      .max(USER_INPUT_LIMITS.maxDescriptionChars)
      .describe("What this choice means or what happens if it is picked."),
  })
  .strict();

/**
 * The questions of `askUserQuestion` and `updateInboxItem`. The keys are
 * the ones of Claude Code's `AskUserQuestion`, which models know, so they
 * are camelCase where it is (`multiSelect`).
 */
export const questionsSchema = z
  .array(
    z
      .object({
        question: z
          .string()
          .trim()
          .min(1)
          .max(USER_INPUT_LIMITS.maxFieldDescriptionChars)
          .describe(
            "The complete question, clear and specific, ending with a question mark.",
          ),
        header: z
          .string()
          .trim()
          .min(1)
          .max(12)
          .describe(
            "A very short label for the question, max 12 characters, such as `Approach`.",
          ),
        options: z
          .array(questionOptionSchema)
          .min(USER_INPUT_LIMITS.minOptions)
          .max(4)
          .describe(
            'The 2-4 choices. Put the recommended one first and end its label with "(Recommended)". Do not add an "Other" choice: the person can always write their own answer.',
          ),
        multiSelect: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            "True lets the person pick more than one choice. Default false.",
          ),
      })
      .strict(),
  )
  .min(1)
  .max(USER_INPUT_LIMITS.maxFields)
  .describe(
    "The questions to ask, 1-4. Ask each decision as its own question, with its own choices, not several decisions in one question.",
  );

/** Cut text to the length of an item title, as a question's title is cut. */
export function cutInboxItemTitle(text: string): string {
  return text.length <= MAX_TITLE_CHARS
    ? text
    : `${text.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

/**
 * Store each question as one field with its own question, header, and
 * choices, and no question that the fields share, so every surface shows
 * each question with its own answer. A label that ends with
 * "(Recommended)" becomes a recommended choice.
 */
export function questionContent(
  questions: z.output<typeof questionsSchema>,
): QuestionContent & { request: z.output<typeof inboxItemRequestSchema> } {
  const fields: UserInputField[] = questions.map((entry, index) => ({
    id: `q${index + 1}`,
    label: entry.header,
    description: entry.question,
    kind: entry.multiSelect ? "multi_choice" : "choice",
    options: entry.options.map((option) => {
      const label = option.label.replace(RECOMMENDED_SUFFIX, "").trim();
      return {
        label: label || option.label,
        description: option.description,
        ...(label && label !== option.label
          ? { recommended: true }
          : undefined),
      };
    }),
  }));
  const request = parseToolInput(inboxItemRequestSchema, { fields });
  return {
    body: questions.map((entry) => entry.question).join("\n\n"),
    request,
    title: cutInboxItemTitle(
      questions.length === 1
        ? questions[0]!.question
        : questions.map((entry) => entry.header).join(" · "),
    ),
  };
}
