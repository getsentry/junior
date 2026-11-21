import {
  isMissingPathError,
  normalizeToLf,
  resolveWorkspacePath,
  type SandboxFileSystem,
} from "@/chat/sandbox/file-utils";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";
import {
  buildCompactDiff,
  detectLineEnding,
  restoreLineEndings,
  stripBom,
  validateAndApplyTextEdits,
  type TextReplacement,
} from "@/chat/tool-support/text-edits";

interface EditFileResult {
  content: [{ type: "text"; text: string }];
  details: {
    diff: string;
    first_changed_line?: number | undefined;
    path: string;
    replacements: number;
    target: string;
    truncated: boolean;
  };
}

/** Apply exact, ordered file replacements through the sandbox filesystem API. */
export async function editFile(params: {
  edits: TextReplacement[];
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
