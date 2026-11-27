/**
 * Who can read each repository that the Sandbox cloned, keyed by clone URL,
 * for the push check (`sandbox-boundary`). A tool whose `guardian` target is
 * a clone URL records it, and a Workspace checkout's plugin describes it.
 * A push URL that no record holds counts as `world`.
 */
import { mapBounded } from "@/chat/fan-out";
import {
  actionFromGuardian,
  guardianContext,
} from "@/chat/guardian/call-facts";
import type { Target } from "@/chat/guardian/guardian";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import { runBestEffort } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { createCache } from "@/chat/state/cache";
import type { ActionDescription } from "@/chat/tool-support/definition";

// As long as a Sandbox can keep its files.
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const records = () => createCache(getStateAdapter(), "guardian-checkouts");

/**
 * The key of a repository URL: host and path, without credentials or a
 * `.git` suffix, so the HTTPS and SSH forms of one clone URL match. An
 * scp-like URL, such as `git@github.com:o/r.git`, is read as SSH. Text that
 * is not such a URL has no key.
 */
export function repositoryUrlKey(text: string): string | undefined {
  const scp = /^([^@/:\s]+@)?([^/:\s]+):(?!\/\/)(\S+)$/.exec(text);
  let url: URL;
  try {
    url = new URL(scp ? `ssh://${scp[2]}/${scp[3]}` : text);
  } catch {
    return undefined;
  }
  if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  return path && path !== "/"
    ? `${url.hostname.toLowerCase()}${path}`
    : undefined;
}

/** Record the target of a clone, when its target is a clone URL. */
export async function recordCheckoutTarget(
  conversationId: string,
  target: Target,
): Promise<void> {
  const key = repositoryUrlKey(target.ref);
  if (!key) return;
  await records().update<Record<string, Target>>(conversationId, (current) => ({
    value: { ...current, [key]: target },
    ttlMs: RECORD_TTL_MS,
  }));
}

/**
 * Record the target of a finished call when it is a clone URL. A record
 * that fails only leaves the URL unknown, which counts as `world`, so the
 * call's result stands.
 */
export async function recordClone(
  conversationId: string,
  answer: Promise<ActionDescription> | undefined,
): Promise<void> {
  await runBestEffort(async () => {
    const target = (await answer)?.target;
    if (target) await recordCheckoutTarget(conversationId, target);
  }, "guardian.clone_record_failed");
}

/**
 * The recorded clone targets of one Conversation's Sandbox, and the
 * checkouts of its Workspace, which their plugins describe now.
 */
export async function readCheckoutTargets(args: {
  conversationId: string;
  conversationIds(): Promise<string[]>;
  workspaceRepos: readonly { provider: string; repo: string }[];
}): Promise<Map<string, Target>> {
  const targets = new Map(
    Object.entries(
      (await records().get<Record<string, Target>>(args.conversationId)) ?? {},
    ),
  );
  const workspace = await mapBounded(args.workspaceRepos, async (repo) => {
    const plugin = getPlugins().find(
      (candidate) => candidate.manifest.name === repo.provider,
    );
    const result = await plugin?.hooks?.guardian?.(
      { kind: "workspaceCheckout", repo: repo.repo },
      guardianContext({
        plugin: repo.provider,
        conversationIds: args.conversationIds,
      }),
    );
    return result ? actionFromGuardian(result).target : undefined;
  });
  for (const target of workspace) {
    const key = target && repositoryUrlKey(target.ref);
    if (target && key) targets.set(key, target);
  }
  return targets;
}

/** The target of one remote or push URL. An unrecorded URL is `world`. */
export function targetOfUrl(
  url: string,
  targets: ReadonlyMap<string, Target>,
): Target {
  const key = repositoryUrlKey(url);
  return (key && targets.get(key)) || { ref: url, audience: "world" };
}
