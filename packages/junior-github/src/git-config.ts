/**
 * Git identity and commit-hook setup for GitHub sandboxes.
 */
import type {
  Actor,
  SandboxPrepareHookContext,
} from "@sentry/junior-plugin-api";

function cleanIdentityPart(value: unknown): string {
  return String(value ?? "")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replace(/[<>]/g, "")
    .trim();
}

function isSlackUserId(value: string): boolean {
  return /^[UW][A-Z0-9]{5,}$/.test(value);
}

function isUserActor(
  actor: Actor | undefined,
): actor is Extract<Actor, { userId: string }> {
  return Boolean(actor && "userId" in actor);
}

function actorDisplayName(value: unknown, actor?: Actor): string | undefined {
  const name = cleanIdentityPart(value);
  if (
    !name ||
    name.toLowerCase() === "unknown" ||
    name === cleanIdentityPart(isUserActor(actor) ? actor.userId : undefined)
  ) {
    return undefined;
  }
  return isSlackUserId(name) ? undefined : name;
}

function actorName(actor?: Actor): string | undefined {
  if (!isUserActor(actor)) {
    return undefined;
  }
  return (
    actorDisplayName(actor?.fullName, actor) ||
    actorDisplayName(actor?.userName, actor) ||
    undefined
  );
}

function actorEmail(actor?: Actor): string | undefined {
  if (!isUserActor(actor)) {
    return undefined;
  }
  const email = cleanIdentityPart(actor?.email);
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : undefined;
}

/**
 * Stable identity key for an actor, matching the distinctness rule
 * `instructionActors` uses to build `run.actors` (identity ids only, never
 * display fields) so the run actor is recognized here even under a different
 * display profile.
 */
function actorIdentityKey(actor: Actor): string {
  if (actor.platform === "system") {
    return `system ${actor.name}`;
  }
  return actor.platform === "slack"
    ? `slack ${actor.teamId} ${actor.userId}`
    : `${actor.platform} ${actor.userId}`;
}

/**
 * Build `Co-Authored-By` trailers crediting human run actors.
 *
 * `run.actors` is attribution only (see `multi-actor-runs.md`): a steerer
 * without a resolvable name and email is silently omitted rather than
 * denying the commit. Dedupes by identity and resolved email so the same human
 * under two display profiles, or an actor matching the bot identity, only ever
 * produces one line.
 */
export function additionalActorCoauthorTrailers(args: {
  actors?: Actor[];
  botEmail: string;
}): string[] {
  if (!args.actors || args.actors.length === 0) {
    return [];
  }
  const seenEmails = new Set<string>([args.botEmail.toLowerCase()]);
  const seenActors = new Set<string>();
  const trailers: string[] = [];
  for (const candidate of args.actors) {
    const actorKey = actorIdentityKey(candidate);
    if (seenActors.has(actorKey)) {
      continue;
    }
    const name = actorName(candidate);
    const email = actorEmail(candidate);
    if (!name || !email) {
      continue;
    }
    const emailKey = email.toLowerCase();
    if (seenEmails.has(emailKey)) {
      continue;
    }
    seenActors.add(actorKey);
    seenEmails.add(emailKey);
    trailers.push(`Co-Authored-By: ${name} <${email}>`);
  }
  return trailers;
}

/**
 * Client-side hook names Git may invoke.
 *
 * When `core.hooksPath` replaces `.git/hooks`, Junior must provide a forwarder
 * for each name so repository hooks still run.
 */
export const FORWARDED_GIT_HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-rewrite",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-auto-gc",
] as const;

/**
 * Resolve the repository's native hooks dir.
 *
 * Do not use `git rev-parse --git-path hooks` here: with `core.hooksPath` set,
 * that path is the Junior hooks dir, not `$GIT_DIR/hooks`.
 */
function repoHookForwardBash(): string {
  return `
# Forward to the repository hook of the same name, if present and distinct.
# core.hooksPath replaces .git/hooks entirely, so Junior must chain explicitly.
forward_repo_hook() {
  local hook_name git_common_dir repo_hook this_hook target_hook
  hook_name=$(basename "$0")
  git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null || true)
  if [ -z "\${git_common_dir:-}" ]; then
    return 0
  fi
  repo_hook="\${git_common_dir}/hooks/\${hook_name}"
  if [ ! -f "$repo_hook" ] || [ ! -x "$repo_hook" ]; then
    return 0
  fi
  this_hook=$(realpath "$0" 2>/dev/null || printf '%s' "$0")
  target_hook=$(realpath "$repo_hook" 2>/dev/null || printf '%s' "$repo_hook")
  if [ "$this_hook" = "$target_hook" ]; then
    return 0
  fi
  "$repo_hook" "$@"
}
`;
}

/** Build a hooksPath entry that only forwards to the repository hook. */
export function forwardGitHookScript(): string {
  return `#!/usr/bin/env bash
set -eu
${repoHookForwardBash()}
forward_repo_hook "$@"
`;
}

/**
 * Build the prepare-commit-msg hook.
 *
 * Runs the repository hook first (so templates and local edits apply), then
 * replaces model-supplied co-author attribution with host-owned trailers.
 */
export function prepareCommitMsgHook(): string {
  return `#!/usr/bin/env bash
set -eu
${repoHookForwardBash()}

# Let the repository edit the message before Junior enforces attribution.
forward_repo_hook "$@"

message_file="\${1:-}"
if [ -z "$message_file" ]; then
  exit 1
fi

if [ -z "\${JUNIOR_GIT_AUTHOR_NAME:-}" ] || [ -z "\${JUNIOR_GIT_AUTHOR_EMAIL:-}" ]; then
  echo "Junior GitHub plugin internal error: Junior author identity was not injected by the host runtime. Do not set Git author env vars manually; report this configuration error." >&2
  exit 1
fi

if [ "\${GIT_AUTHOR_NAME:-}" != "$JUNIOR_GIT_AUTHOR_NAME" ] || [ "\${GIT_AUTHOR_EMAIL:-}" != "$JUNIOR_GIT_AUTHOR_EMAIL" ]; then
  echo "Junior GitHub plugin internal error: Git author was not set to the Junior identity. Do not override Git author manually; report this configuration error." >&2
  exit 1
fi

# Git and GitHub only interpret the final contiguous paragraph as the trailer
# block, so all missing trailers are collected and appended as one block:
# human actor trailers in run order.
desired_trailers=""
add_trailer() {
  desired_trailers="$desired_trailers$1"$'\\n'
}

if [ -n "\${JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS:-}" ]; then
  while IFS= read -r actor_trailer; do
    if [ -n "$actor_trailer" ]; then
      add_trailer "$actor_trailer"
    fi
  done <<< "$JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS"
fi

# The hook owns co-author attribution. Remove every model-supplied co-author
# from the final Git trailer block before appending the host-derived actors.
tmp_file=$(mktemp)
trap 'rm -f "$tmp_file"' EXIT
awk '
  { lines[NR] = $0 }
  END {
    line = NR
    while (line > 0 && lines[line] == "") {
      line--
    }
    start = line
    while (start > 0 && lines[start] != "") {
      start--
    }
    valid = line > 0
    for (i = start + 1; valid && i <= line; i++) {
      if (lines[i] !~ /^[[:alnum:]-]+: .+/) {
        valid = 0
      }
    }
    if (!valid) {
      for (i = 1; i <= NR; i++) {
        print lines[i]
      }
      exit 0
    }
    kept = 0
    for (i = start + 1; i <= line; i++) {
      if (tolower(lines[i]) !~ /^co-authored-by: /) {
        kept++
      }
    }
    before = kept > 0 ? start : start - 1
    for (i = 1; i <= before; i++) {
      print lines[i]
    }
    for (i = start + 1; i <= line; i++) {
      if (tolower(lines[i]) !~ /^co-authored-by: /) {
        print lines[i]
      }
    }
  }
' "$message_file" > "$tmp_file"
cat "$tmp_file" > "$message_file"

final_trailer_block=$(awk '
  { lines[NR] = $0 }
  END {
    line = NR
    while (line > 0 && lines[line] == "") {
      line--
    }
    if (line == 0) {
      exit 0
    }
    start = line
    while (start > 0 && lines[start] != "") {
      start--
    }
    for (i = start + 1; i <= line; i++) {
      if (lines[i] !~ /^[[:alnum:]-]+: .+/) {
        exit 0
      }
    }
    for (i = start + 1; i <= line; i++) {
      print lines[i]
    }
  }
' "$message_file")

missing_trailers=""
collect_missing_trailer() {
  if ! printf '%s\\n' "$final_trailer_block" | grep -Fqx -- "$1"; then
    missing_trailers="\${missing_trailers}\${1}"$'\\n'
  fi
}

while IFS= read -r desired_trailer; do
  if [ -n "$desired_trailer" ]; then
    collect_missing_trailer "$desired_trailer"
  fi
done <<< "$desired_trailers"

if [ -z "$missing_trailers" ]; then
  exit 0
fi

if [ -n "$(tail -c 1 "$message_file")" ]; then
  printf '\\n' >> "$message_file"
fi

if [ -n "$final_trailer_block" ]; then
  printf '%s' "$missing_trailers" >> "$message_file"
else
  printf '\\n%s' "$missing_trailers" >> "$message_file"
fi
`;
}

/** Set one global Git option inside the prepared sandbox. */
export async function configureGit(
  ctx: SandboxPrepareHookContext,
  key: string,
  value: string,
): Promise<void> {
  const result = await ctx.sandbox.run({
    cmd: "git",
    args: ["config", "--global", key, value],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to configure git ${key}: ${result.stderr || result.stdout}`,
    );
  }
}

/**
 * Install Junior's hooksPath directory.
 *
 * Writes the attribution hook plus forwarders for other client-side hooks, then
 * points global `core.hooksPath` at that directory.
 */
export async function installSandboxGitHooks(
  ctx: SandboxPrepareHookContext,
): Promise<void> {
  const hooksPath = `${ctx.sandbox.juniorRoot}/git-hooks`;
  for (const hookName of FORWARDED_GIT_HOOK_NAMES) {
    const content =
      hookName === "prepare-commit-msg"
        ? prepareCommitMsgHook()
        : forwardGitHookScript();
    await ctx.sandbox.writeFile({
      path: `${hooksPath}/${hookName}`,
      mode: 0o755,
      content,
    });
  }
  await configureGit(ctx, "core.hooksPath", hooksPath);
  await configureGit(ctx, "commit.gpgsign", "false");
  await configureGit(ctx, "credential.helper", "");
  await configureGit(ctx, "http.emptyAuth", "true");
}
