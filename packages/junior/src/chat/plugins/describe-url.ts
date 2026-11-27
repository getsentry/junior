import * as z from "zod";
import type { Target } from "@/chat/guardian/guardian";
import { getPlugins } from "@/chat/plugins/hooks/registry";

const targetSchema = z.object({
  ref: z.string().min(1),
  audience: z.enum(["internal", "world"]),
});

/**
 * Read a Git remote as a URL. An scp-like remote, such as
 * `git@github.com:o/r.git`, becomes `ssh://git@github.com/o/r.git`.
 */
function remoteUrl(remote: string): URL | undefined {
  const scp = /^([^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(remote);
  const text = scp ? `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}` : remote;
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/**
 * Ask each plugin with a `describeUrl` hook for the target behind one Git
 * remote. The first plugin that knows it answers. A remote that no plugin
 * knows is its own target, which the world can read (`audience`). Upkeep
 * never applies to a command, so no remote counts as created by this work.
 */
export async function describeRemote(remote: string): Promise<Target> {
  const url = remoteUrl(remote);
  if (url) {
    for (const plugin of getPlugins()) {
      // oxlint-disable-next-line no-await-in-loop -- The first plugin that knows the URL answers.
      const target = await plugin.hooks?.describeUrl?.(url);
      if (target) {
        return { ...targetSchema.parse(target), createdByThisWork: false };
      }
    }
  }
  return { ref: remote, audience: "world", createdByThisWork: false };
}
