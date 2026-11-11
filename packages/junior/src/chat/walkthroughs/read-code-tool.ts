/**
 * The tool that reads the code of a Walkthrough's code changes for a
 * question Turn, through the provider's code-change hooks. It reads only the
 * commits the version describes.
 */
import * as z from "zod";
import {
  readPluginCodeChangeDiff,
  readPluginCodeFile,
} from "@/chat/plugins/code-change-hooks";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { WalkthroughQuestions } from "./questions";

export const READ_WALKTHROUGH_CODE_TOOL_NAME = "readWalkthroughCode";

const READ_TIMEOUT_MS = 30_000;

/** Create `readWalkthroughCode` for one question Turn. */
export function createReadWalkthroughCodeTool(questions: WalkthroughQuestions) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "Read one code change of the Walkthrough: its diff, or one file at its head commit, changed or not.",
    inputSchema: z
      .object({
        pr: z
          .number()
          .int()
          .positive()
          .describe("Number of a code change in the Walkthrough."),
        path: z
          .string()
          .trim()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "Repository path of a file to read at the head commit. Omit or null for the diff.",
          ),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema.extend({
      pr: z.number().int(),
      files: z
        .array(
          z.object({
            path: z.string(),
            status: z.string(),
            patch: z.string().optional(),
          }),
        )
        .optional(),
      path: z.string().optional(),
      text: z.string().optional(),
    }),
    execute: async ({ pr, path }) => {
      const layer = questions.layers.find((change) => change.number === pr);
      if (!layer) {
        throw new ToolInputError(
          `#${pr} is not in this Walkthrough. Use a number from readWalkthrough.`,
        );
      }
      const target = {
        provider: questions.provider,
        repository: questions.repository,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      };
      if (!path) {
        const diff = await readPluginCodeChangeDiff({
          ...target,
          baseSha: layer.baseSha,
          headSha: layer.headSha,
        });
        return {
          pr,
          files: diff.files.map((file) => ({
            path: file.path,
            status: file.status,
            ...(file.patch ? { patch: file.patch } : undefined),
          })),
        };
      }
      const text = await readPluginCodeFile({
        ...target,
        sha: layer.headSha,
        path,
      });
      if (text === undefined) {
        throw new ToolInputError(
          `${path} does not exist at the head of #${pr}.`,
        );
      }
      return { pr, path, text };
    },
  });
}
