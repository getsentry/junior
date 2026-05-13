import type { Sandbox } from "@vercel/sandbox";

/** Return the SDK sandbox identifier across stable and beta Sandbox shapes. */
export function sandboxIdentifier(sandbox: Sandbox): string | undefined {
  const sandboxLike = sandbox as Sandbox & {
    name?: string;
    sandboxId?: string;
  };
  return sandboxLike.sandboxId ?? sandboxLike.name;
}
