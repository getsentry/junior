import { createHash } from "node:crypto";
import { z } from "zod";

export const workspaceSnapshotJobMessageSchema = z
  .object({
    workspaceId: z.string().uuid(),
    profileHash: z.string().min(1),
  })
  .strict();

export type WorkspaceSnapshotJobMessage = z.output<
  typeof workspaceSnapshotJobMessageSchema
>;

/** Stable queue idempotency key for one Workspace profile build. */
export function workspaceSnapshotJobId(
  message: WorkspaceSnapshotJobMessage,
): string {
  const digest = createHash("sha256")
    .update(message.workspaceId)
    .update("\0")
    .update(message.profileHash)
    .digest("hex")
    .slice(0, 32);
  return `workspace-snapshot_${digest}`;
}

/** Parse the bounded queue payload accepted by the snapshot build callback. */
export function parseWorkspaceSnapshotJobMessage(
  value: unknown,
): WorkspaceSnapshotJobMessage | undefined {
  const parsed = workspaceSnapshotJobMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
