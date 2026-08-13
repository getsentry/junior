import { createHash } from "node:crypto";
import { z } from "zod";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import { publishImage } from "@/chat/published-images/store";
import type { PublishedImageStorage } from "@/chat/published-images/storage";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import {
  normalizeSandboxPath,
  SandboxFileNotFoundError,
} from "@/chat/tools/sandbox/file-uploads";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { ToolState } from "@/chat/tools/types";

const publishImageInputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "Exact sandbox path of an existing image file. Preserve paths returned by other tools unchanged.",
      ),
    alt: z
      .string()
      .max(200)
      .optional()
      .describe("Optional alt text for the returned markdown image reference."),
  })
  .strict();

const publishImageOutputSchema = juniorToolOutputSchema.extend({
  bytes: z.number().int().nonnegative(),
  content_type: z.string().min(1),
  deduplicated: z.boolean().optional(),
  markdown: z.string().min(1),
  /**
   * True when the image is reachable by anyone on the internet who has the URL.
   * This is not private attachment storage.
   */
  public: z.literal(true),
  url: z.string().url(),
});

type PublishImageResult = z.output<typeof publishImageOutputSchema>;

/** Create the tool that publishes a sandbox image to a durable public URL. */
export function createPublishImageTool(args: {
  publicBaseUrl?: () => string | undefined;
  state: ToolState;
  storage: PublishedImageStorage;
  workspace: SandboxWorkspace;
}) {
  const resolvePublicBaseUrl = args.publicBaseUrl ?? resolveBaseUrl;
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    approvalMode: "review",
    description:
      "Publish one sandbox image to a durable public HTTPS URL. The image becomes public to anyone on the internet who has the URL. Use only when a destination needs a public image link, such as a GitHub issue, pull request, review, or comment. Do not use for private Slack sharing (use sendFiles) or private conversation storage. Supports PNG, JPEG, GIF, and WebP up to 10 MB. Returns the public URL and markdown image syntax.",
    describeProposal(input) {
      return `Publish sandbox image ${input.path} to a public internet URL.`;
    },
    executionMode: "sequential",
    inputSchema: publishImageInputSchema,
    outputSchema: publishImageOutputSchema,
    privateTraceResult: (result) => ({
      bytes: result.bytes,
      content_type: result.content_type,
      deduplicated: result.deduplicated,
      public: result.public,
      url: result.url,
    }),
    async execute({ path, alt }) {
      const publicBaseUrl = resolvePublicBaseUrl()?.trim();
      if (!publicBaseUrl) {
        throw new ToolInputError(
          "publishImage requires JUNIOR_BASE_URL or a Vercel deployment URL so the public image link can be built.",
        );
      }

      const targetPath = normalizeSandboxPath(path);
      const data = await args.workspace.readFileToBuffer({ path: targetPath });
      if (!data) {
        throw new SandboxFileNotFoundError(targetPath);
      }

      const operationKey = createOperationKey("publishImage", {
        alt: alt ?? null,
        path: targetPath,
        public_base_url: publicBaseUrl,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
      const cached = args.state.getOperationResult<PublishImageResult>(
        operationKey,
      );
      if (cached) {
        return publishImageOutputSchema.parse({
          ...cached,
          deduplicated: true,
        });
      }

      let published;
      try {
        published = await publishImage({
          ...(alt ? { alt } : {}),
          body: data,
          publicBaseUrl,
          storage: args.storage,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "failed to publish image";
        throw new ToolInputError(message);
      }

      const result: PublishImageResult = {
        bytes: published.bytes,
        content_type: published.contentType,
        markdown: published.markdown,
        public: true,
        url: published.url,
      };
      args.state.setOperationResult(operationKey, result);
      return result;
    },
  });
}
