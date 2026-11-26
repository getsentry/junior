import type { ToolState } from "@/chat/tool-support/types";
import {
  sendFiles,
  sendFilesInputSchema,
  sendFilesResultSchema,
  type FileAttachments,
  type MaterializeFile,
} from "@/chat/tool-support/send-files";
import { zodTool } from "@/chat/tool-support/zod-tool";

/**
 * Store files in the active Conversation, on a platform with no Location to
 * deliver them to.
 *
 * @runBuilt sendFiles
 */
export function createSendFilesTool(
  state: ToolState,
  materializeFile: MaterializeFile,
  attachments: FileAttachments,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Attach one or more sandbox files to the active conversation. Files use the conversation's access rules; this does not publish public URLs.",
    inputSchema: sendFilesInputSchema,
    outputSchema: sendFilesResultSchema,
    execute: (input, options) =>
      sendFiles(input, options, state, materializeFile, { attachments }),
  });
}
