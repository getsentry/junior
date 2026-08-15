import { createHash } from "node:crypto";
import { z } from "zod";

export const workspacePrebuildQueueMessageSchema = z
  .object({
    workspaceId: z.string().trim().min(1),
  })
  .strict();

export type WorkspacePrebuildQueueMessage = z.output<
  typeof workspacePrebuildQueueMessageSchema
>;

/** Build the stable task id used for queue idempotency and tracing. */
export function workspacePrebuildTaskId(args: {
  deploymentId?: string;
  workspaceId: string;
}): string {
  const digest = createHash("sha256")
    .update(args.workspaceId)
    .update("\0")
    .update(args.deploymentId?.trim() || "local")
    .digest("hex")
    .slice(0, 32);
  return `workspace-prebuild_${digest}`;
}

/** Parse the bounded queue payload accepted by the Workspace prebuild callback. */
export function parseWorkspacePrebuildQueueMessage(
  value: unknown,
): WorkspacePrebuildQueueMessage | undefined {
  const parsed = workspacePrebuildQueueMessageSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}
