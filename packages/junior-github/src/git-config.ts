/**
 * Git identity and commit-hook setup for GitHub sandboxes.
 */
import type {
  Actor,
  SandboxPrepareHookContext,
  User,
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
 * Prefer a GitHub noreply address when the linked user has a GitHub identity.
 * That form encodes a resolvable login for downstream assignee automation.
 */
function githubNoreplyEmail(user?: User): string | undefined {
  for (const identity of user?.identities ?? []) {
    if (identity.provider !== "github") {
      continue;
    }
    const login = cleanIdentityPart(identity.handle);
    const userId = cleanIdentityPart(identity.providerSubjectId);
    if (!login || login.toLowerCase().endsWith("[bot]")) {
      continue;
    }
    if (/^[1-9]\d*$/.test(userId)) {
      return `${userId}+${login}@users.noreply.github.com`;
    }
    return `${login}@users.noreply.github.com`;
  }
  return undefined;
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
 *
 * When the current actor has a linked GitHub identity, prefer that noreply
 * address so external automation can resolve a login for assignment.
 */
export function additionalActorCoauthorTrailers(args: {
  actors?: Actor[];
  botEmail: string;
  /** Linked user for the current run actor, when already resolved. */
  currentUser?: User;
}): string[] {
  if (!args.actors || args.actors.length === 0) {
    return [];
  }
  const currentActorKey = args.actors[0]
    ? actorIdentityKey(args.actors[0])
    : undefined;
  const currentNoreply = githubNoreplyEmail(args.currentUser);
  const seenEmails = new Set<string>([args.botEmail.toLowerCase()]);
  const seenActors = new Set<string>();
  const trailers: string[] = [];
  for (const candidate of args.actors) {
    const actorKey = actorIdentityKey(candidate);
    if (seenActors.has(actorKey)) {
      continue;
    }
    const name = actorName(candidate);
    const email =
      (currentActorKey === actorKey ? currentNoreply : undefined) ||
      actorEmail(candidate);
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

/** Build the hook that replaces model-supplied commit attribution. */
export function prepareCommitMsgHook(): string {
  return `#!/usr/bin/env bash
set -eu

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
