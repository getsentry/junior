import {
  isMissingPathError,
  normalizeToLf,
  resolveWorkspacePath,
  type SandboxFileSystem,
} from "@/chat/tools/sandbox/file-utils";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  juniorToolOutputSchema,
  makeStructuredToolOutput,
} from "@/chat/tool-support/structured-result";
import {
  buildCompactDiff,
  detectLineEnding,
  prepareTextReplacementArguments,
  restoreLineEndings,
  stripBom,
  validateAndApplyTextEdits,
  type TextReplacement,
} from "@/chat/tools/sandbox/text-edits";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";

type EditReplacement = TextReplacement;
interface EditFileResult {
  content: [{ type: "text"; text: string }];
  details: {
    diff: string;
    first_changed_line?: number;
    path: string;
    replacements: number;
    target: string;
    truncated: boolean;
  };
}

interface EditFileInput {
  path: string;
  edits: EditReplacement[];
}

/** Accept common edit argument variants before Pi validates the canonical schema. */
export function prepareEditFileArguments(input: unknown): EditFileInput {
  return prepareTextReplacementArguments(input);
}

/** Apply exact, ordered file replacements through the sandbox filesystem API. */
export async function editFile(params: {
  edits: EditReplacement[];
  fs: SandboxFileSystem;
  path: string;
}): Promise<EditFileResult> {
  const filePath = resolveWorkspacePath(params.path);
  let rawContent: string;
  try {
    rawContent = await params.fs.readFile(filePath, { encoding: "utf8" });
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new ToolInputError(`File not found: ${params.path}`, {
        cause: error,
      });
    }
    throw error;
  }
  const { bom, text } = stripBom(rawContent);
  const lineEnding = detectLineEnding(text);
  const normalizedContent = normalizeToLf(text);
  const applied = validateAndApplyTextEdits(
    normalizedContent,
    params.edits,
    params.path,
  );
  const { baseContent, newContent } = applied;
  await params.fs.writeFile(
    filePath,
    bom + restoreLineEndings(newContent, lineEnding),
    { encoding: "utf8" },
  );

  const diff = buildCompactDiff(baseContent, newContent);
  return makeStructuredToolOutput({
    target: params.path,
    diff: diff.diff,
    first_changed_line: diff.firstChangedLine,
    path: params.path,
    replacements: params.edits.length,
    truncated: diff.truncated,
  });
}

const editReplacementSchema = z.object({
  oldText: z
    .string()
    .min(1)
    .describe(
      "Exact text to replace. It must be unique in the original file and must not overlap another edit.",
    ),
  newText: z.string().describe("Replacement text for this edit."),
});

/** Create the sandbox edit tool definition exposed to the agent. */
export function createEditFileTool() {
  return zodTool({
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Edit one sandbox workspace file with exact text replacements. Use for precise changes to existing files; prefer this over writeFile for targeted changes. Each oldText must match exactly, be unique, and not overlap another edit. Returns a diff. Multiple changes to the same file: use one edits[] call.",
    prepareArguments: prepareEditFileArguments,
    executionMode: "sequential",
    inputSchema: z.object({
      path: z
        .string()
        .min(1)
        .describe("Path to edit in the sandbox workspace."),
      edits: z
        .array(editReplacementSchema)
        .min(1)
        .describe(
          "Exact replacements matched against the original file, not incrementally.",
        ),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async () => {
      throw new Error(
        "editFile can only run when sandbox execution is enabled.",
      );
    },
  });
}
