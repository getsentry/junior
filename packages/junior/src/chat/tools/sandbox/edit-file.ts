import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import {
  prepareTextReplacementArguments,
  type TextReplacement,
} from "@/chat/tool-support/text-edits";
import * as z from "zod";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";

interface EditFileInput {
  path: string;
  edits: TextReplacement[];
}

/** Accept common edit argument variants before Pi validates the canonical schema. */
function prepareEditFileArguments(input: unknown): EditFileInput {
  return prepareTextReplacementArguments(input);
}

const editReplacementSchema = z.object({
  old_text: z
    .string()
    .min(1)
    .describe(
      "Exact text to replace. It must be unique in the original file and must not overlap another edit.",
    ),
  new_text: z.string().describe("Replacement text for this edit."),
});

export const editFileToolDefinition = zodToolDefinition({
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Edit one sandbox workspace file with exact text replacements. Use for precise changes to existing files; prefer this over writeFile for targeted changes. Returns a diff. Multiple changes to the same file: use one edits[] call.",
  prepareArguments: prepareEditFileArguments,
  executionMode: "sequential",
  inputSchema: z.object({
    path: z.string().min(1).describe("Path to edit in the sandbox workspace."),
    edits: z
      .array(editReplacementSchema)
      .min(1)
      .describe(
        "Exact replacements matched against the original file, not incrementally.",
      ),
  }),
  outputSchema: juniorToolOutputSchema,
});

/** Create the sandbox edit tool definition exposed to the agent. */
export function createEditFileTool() {
  return zodTool({
    ...editFileToolDefinition,
    execute: async () => {
      throw new Error(
        "editFile can only run when sandbox execution is enabled.",
      );
    },
  });
}
