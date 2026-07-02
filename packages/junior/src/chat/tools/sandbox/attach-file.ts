import { Type } from "@sinclair/typebox";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { tool } from "@/chat/tools/definition";
import type { ToolHooks } from "@/chat/tools/types";
import {
  normalizeSandboxPath,
  readSandboxFileUpload,
} from "@/chat/tools/sandbox/file-uploads";

/** Create the sandbox file attachment tool used for final Slack replies. */
export function createAttachFileTool(
  sandbox: SandboxWorkspace,
  hooks: ToolHooks = {},
) {
  return tool({
    description:
      "Attach a file to the Slack reply. Use this for files that exist in the sandbox, such as screenshots, PDFs, or logs, or for generated image `attachment_path` values returned earlier in the turn.",
    inputSchema: Type.Object(
      {
        path: Type.String({
          minLength: 1,
          description:
            "Absolute path (for example /tmp/screenshot.png) or workspace-relative path.",
        }),
        filename: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Optional filename override shown in Slack.",
          }),
        ),
        mimeType: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Optional MIME type override (for example image/png).",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async ({ path: requestedPath, filename, mimeType }) => {
      const targetPath = normalizeSandboxPath(requestedPath);
      const file = await readSandboxFileUpload(sandbox, {
        path: targetPath,
        filename,
        mimeType,
      });
      hooks.onGeneratedFiles?.([
        {
          data: file.data,
          filename: file.filename,
          mimeType: file.mimeType,
        },
      ]);

      return {
        ok: true,
        attached: true,
        path: file.path,
        filename: file.filename,
        mime_type: file.mimeType,
        bytes: file.bytes,
      };
    },
  });
}
