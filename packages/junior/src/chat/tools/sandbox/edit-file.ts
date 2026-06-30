import {
  isMissingPathError,
  normalizeToLf,
  resolveWorkspacePath,
  type SandboxFileSystem,
} from "@/chat/tools/sandbox/file-utils";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  buildCompactDiff,
  detectLineEnding,
  prepareTextReplacementArguments,
  restoreLineEndings,
  stripBom,
  validateAndApplyTextEdits,
  type TextReplacement,
} from "@/chat/tools/sandbox/text-edits";
import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

type EditReplacement = TextReplacement;

interface EditFileResult {
  content: [{ type: "text"; text: string }];
  details: {
    diff: string;
    first_changed_line?: number;
    ok: true;
    path: string;
    replacements: number;
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
  const { baseContent, newContent } = validateAndApplyTextEdits(
    normalizedContent,
    params.edits,
    params.path,
  );
  await params.fs.writeFile(
    filePath,
    bom + restoreLineEndings(newContent, lineEnding),
    { encoding: "utf8" },
  );

  const diff = buildCompactDiff(baseContent, newContent);
  return {
    content: [
      {
        type: "text",
        text: `Successfully replaced ${params.edits.length} block(s) in ${params.path}.`,
      },
    ],
    details: {
      diff: diff.diff,
      first_changed_line: diff.firstChangedLine,
      ok: true,
      path: params.path,
      replacements: params.edits.length,
    },
  };
}

const editReplacementSchema = Type.Object(
  {
    oldText: Type.String({
      minLength: 1,
      description:
        "Exact text to replace. It must be unique in the original file and must not overlap another edit.",
    }),
    newText: Type.String({
      description: "Replacement text for this edit.",
    }),
  },
  { additionalProperties: false },
);

/** Create the sandbox edit tool definition exposed to the agent. */
export function createEditFileTool() {
  return tool({
    description:
      "Edit one sandbox workspace file with exact text replacements. Use for precise changes to existing files; prefer this over writeFile for targeted changes. Each oldText must match exactly, be unique, and not overlap another edit. Returns a diff. Multiple changes to the same file: use one edits[] call.",
    prepareArguments: prepareEditFileArguments,
    executionMode: "sequential",
    inputSchema: Type.Object(
      {
        path: Type.String({
          minLength: 1,
          description: "Path to edit in the sandbox workspace.",
        }),
        edits: Type.Array(editReplacementSchema, {
          minItems: 1,
          description:
            "Exact replacements matched against the original file, not incrementally.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      throw new Error(
        "editFile can only run when sandbox execution is enabled.",
      );
    },
  });
}
