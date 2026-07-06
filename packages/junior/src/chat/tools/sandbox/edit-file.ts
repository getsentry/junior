import {
  isMissingPathError,
  normalizeToLf,
  resolveWorkspacePath,
  type SandboxFileSystem,
} from "@/chat/tools/sandbox/file-utils";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  juniorToolResultSchema,
  makeStructuredToolResult,
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
type EditFailureKind =
  | "not_found"
  | "old_text_not_found"
  | "old_text_not_unique"
  | "overlapping_edits"
  | "no_change"
  | "invalid_edit";

interface EditFileResult {
  content: [{ type: "text"; text: string }];
  details:
    | {
        data: {
          diff: string;
          first_changed_line?: number;
          path: string;
          replacements: number;
        };
        diff: string;
        first_changed_line?: number;
        ok: true;
        path: string;
        replacements: number;
        status: "success";
        target: string;
      }
    | {
        data: {
          path: string;
          replacements: number;
        };
        error: {
          kind: EditFailureKind;
          message: string;
          retryable: true;
        };
        ok: false;
        path: string;
        replacements: number;
        status: "error";
        target: string;
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

function editFailureKind(message: string): EditFailureKind {
  if (message.startsWith("File not found:")) {
    return "not_found";
  }
  if (message.startsWith("Could not find")) {
    return "old_text_not_found";
  }
  if (message.startsWith("Found ") && message.includes(" occurrences ")) {
    return "old_text_not_unique";
  }
  if (message.includes(" overlap ")) {
    return "overlapping_edits";
  }
  if (message.startsWith("No changes made")) {
    return "no_change";
  }
  return "invalid_edit";
}

function editFailureResult(params: {
  message: string;
  path: string;
  replacements: number;
}): EditFileResult {
  return makeStructuredToolResult({
    ok: false,
    status: "error",
    target: params.path,
    path: params.path,
    replacements: params.replacements,
    data: {
      path: params.path,
      replacements: params.replacements,
    },
    error: {
      kind: editFailureKind(params.message),
      message: params.message,
      retryable: true,
    },
  });
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
      return editFailureResult({
        message: `File not found: ${params.path}`,
        path: params.path,
        replacements: params.edits.length,
      });
    }
    throw error;
  }
  const { bom, text } = stripBom(rawContent);
  const lineEnding = detectLineEnding(text);
  const normalizedContent = normalizeToLf(text);
  let applied: { baseContent: string; newContent: string };
  try {
    applied = validateAndApplyTextEdits(
      normalizedContent,
      params.edits,
      params.path,
    );
  } catch (error) {
    if (error instanceof ToolInputError) {
      return editFailureResult({
        message: error.message,
        path: params.path,
        replacements: params.edits.length,
      });
    }
    throw error;
  }
  const { baseContent, newContent } = applied;
  await params.fs.writeFile(
    filePath,
    bom + restoreLineEndings(newContent, lineEnding),
    { encoding: "utf8" },
  );

  const diff = buildCompactDiff(baseContent, newContent);
  return makeStructuredToolResult({
    ok: true,
    status: "success",
    target: params.path,
    data: {
      diff: diff.diff,
      first_changed_line: diff.firstChangedLine,
      path: params.path,
      replacements: params.edits.length,
    },
    diff: diff.diff,
    first_changed_line: diff.firstChangedLine,
    path: params.path,
    replacements: params.edits.length,
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
    outputSchema: juniorToolResultSchema,
    execute: async () => {
      throw new Error(
        "editFile can only run when sandbox execution is enabled.",
      );
    },
  });
}
