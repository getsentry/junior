/**
 * Git identity and commit-hook setup for GitHub sandboxes.
 */
import type {
  Actor,
  PluginEnv,
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
  currentUser?: User | undefined;
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

/**
 * Client hooks that Junior's hooks directory passes to the repository.
 *
 * Junior's `core.hooksPath` replaces the repository hooks directory: the
 * repository's own `core.hooksPath` (husky) or `.git/hooks` (simple-git-hooks,
 * Git LFS). Git would skip those hooks without these pass-through hooks.
 * `prepare-commit-msg` is not in the list because Junior's own hook runs the
 * repository hook first.
 */
export const REPOSITORY_HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "post-rewrite",
  "pre-auto-gc",
] as const;

/** Directory for Junior's Git hooks under the sandbox Junior root. */
export function gitHooksPath(juniorRoot: string): string {
  return `${juniorRoot}/git-hooks`;
}

/**
 * Point Git at Junior's hooks for one command.
 *
 * Command env config has a higher priority than every config file, so it
 * also wins over a repository `core.hooksPath` such as husky's.
 */
export function setGitHooksPathEnv(env: PluginEnv, hooksPath: string): void {
  const index = Number.parseInt(env.get("GIT_CONFIG_COUNT") ?? "0", 10) || 0;
  env.set(`GIT_CONFIG_KEY_${index}`, "core.hooksPath");
  env.set(`GIT_CONFIG_VALUE_${index}`, hooksPath);
  env.set("GIT_CONFIG_COUNT", String(index + 1));
}

/**
 * Bash that sets `repository_hook` to the repository's own hook, if any.
 * `git config --local` reads only the repository config file, so Junior's
 * env config does not hide the repository value. Hooks run from the top of
 * the worktree, so a relative path works as Git resolves it.
 */
function findRepositoryHook(name: string): string {
  return `repository_hook=""
repository_hooks_dir=$(git config --local --type=path core.hooksPath 2>/dev/null) || repository_hooks_dir=""
if [ -z "$repository_hooks_dir" ]; then
  git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || git_common_dir=""
  if [ -n "$git_common_dir" ]; then
    repository_hooks_dir="$git_common_dir/hooks"
  fi
fi
if [ -n "$repository_hooks_dir" ] && [ -x "$repository_hooks_dir/${name}" ]; then
  repository_hooks_real=$(CDPATH='' cd -- "$repository_hooks_dir" && pwd -P) || repository_hooks_real=""
  junior_hooks_real=$(CDPATH='' cd -- "\${0%/*}" && pwd -P) || junior_hooks_real=""
  if [ "$repository_hooks_real" != "$junior_hooks_real" ]; then
    repository_hook="$repository_hooks_dir/${name}"
  fi
fi`;
}

/** Build a hook that runs the repository's own hook with the same name. */
export function repositoryHook(name: string): string {
  return `#!/usr/bin/env bash
set -eu

${findRepositoryHook(name)}
if [ -n "$repository_hook" ]; then
  exec "$repository_hook" "$@"
fi
`;
}

/**
 * Awk program that sets the co-author trailers of a commit message.
 *
 * It removes every `Co-authored-by` line from paragraphs made only of
 * trailers, so model-supplied co-authors never reach a commit. Then it
 * appends the trailers in `JUNIOR_COAUTHOR_TRAILERS`, deduplicated by email
 * and without the bot, to the final trailer paragraph. Like Git, it never
 * treats the subject paragraph as trailers. A trailer key starts with a
 * capital letter, so a conventional commit subject such as `feat: x` in a
 * squash message stays body text. It keeps the comment block that Git adds
 * for an editor at the end. A message with no content stays empty, so Git
 * still aborts the commit.
 *
 * With `JUNIOR_COAUTHOR_LIST` set, it prints only the `Co-authored-by` lines
 * that it would remove. The hook uses this to read the co-authors of a
 * rewritten commit with the same rules, so a squash-style message keeps the
 * co-authors in its earlier trailer paragraphs too.
 *
 * The hook puts this program in single quotes, so it must not contain one.
 */
const SET_COAUTHOR_TRAILERS_AWK = String.raw`
function blank(line) { return line ~ /^[[:space:]]*$/ }
function comment(line) { return substr(line, 1, 1) == "#" }
function trailer(line) {
  return coauthor(line) || line ~ /^[A-Z][[:alnum:]-]*: ./ || line ~ /^\(cherry picked from commit [0-9a-f]+\)$/
}
function coauthor(line) { return tolower(line) ~ /^co-authored-by: / }
{ lines[NR] = $0 }
END {
  last = NR
  while (last > 0 && (blank(lines[last]) || comment(lines[last]))) last--
  count = 0
  i = 1
  while (i <= last) {
    count++
    gap[count] = i
    while (blank(lines[i])) i++
    first[count] = i
    while (i <= last && !blank(lines[i])) i++
    final[count] = i - 1
  }
  subject = 0
  content_count = 0
  for (p = 1; p <= count; p++) {
    content = 0
    trailers = 1
    for (j = first[p]; j <= final[p]; j++) {
      if (comment(lines[j])) continue
      content = 1
      if (!trailer(lines[j])) trailers = 0
    }
    if (content && !subject) subject = p
    trailer_paragraph[p] = content && trailers
    kept[p] = 0
    kept_content[p] = 0
    for (j = first[p]; j <= final[p]; j++) {
      drop[j] = trailer_paragraph[p] && coauthor(lines[j])
      if (drop[j]) continue
      kept[p]++
      if (!comment(lines[j])) kept_content[p]++
    }
    if (kept_content[p]) content_count++
  }
  if (ENVIRON["JUNIOR_COAUTHOR_LIST"] != "") {
    for (j = 1; j <= last; j++) {
      if (!drop[j]) continue
      line = lines[j]
      sub(/^[^:]*:[[:space:]]*/, "", line)
      print "Co-Authored-By: " line
    }
    exit
  }
  last_paragraph = 0
  for (p = 1; p <= count; p++) {
    if (!kept[p]) continue
    for (j = gap[p]; j < first[p]; j++) print lines[j]
    for (j = first[p]; j <= final[p]; j++) if (!drop[j]) print lines[j]
    last_paragraph = p
  }
  if (content_count) {
    inline = last_paragraph != subject && trailer_paragraph[last_paragraph] && kept_content[last_paragraph]
    bot = tolower(ENVIRON["JUNIOR_GIT_AUTHOR_EMAIL"])
    n = split(ENVIRON["JUNIOR_COAUTHOR_TRAILERS"], wanted, "\n")
    for (k = 1; k <= n; k++) {
      line = wanted[k]
      if (line !~ /^Co-Authored-By: [^<>]+ <[^<>[:space:]]+@[^<>[:space:]]+>$/) continue
      email = tolower(line)
      sub(/^[^<]*</, "", email)
      sub(/>$/, "", email)
      if (email == bot || seen[email]++) continue
      if (!inline) print ""
      inline = 1
      print line
    }
  }
  for (j = last + 1; j <= NR; j++) print lines[j]
}
`;

/** Build the hook that replaces model-supplied commit attribution. */
export function prepareCommitMsgHook(): string {
  return `#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ -z "$1" ]; then
  exit 1
fi
message_file=$1
commit_source=""
if [ "$#" -ge 2 ]; then
  commit_source=$2
fi
source_commit=""
if [ "$#" -ge 3 ]; then
  source_commit=$3
fi

# Run the repository hook first so Junior's trailers stay final.
${findRepositoryHook("prepare-commit-msg")}
if [ -n "$repository_hook" ]; then
  "$repository_hook" "$@"
fi

if [ -z "\${JUNIOR_GIT_AUTHOR_NAME:-}" ] || [ -z "\${JUNIOR_GIT_AUTHOR_EMAIL:-}" ]; then
  echo "GitHub plugin internal error: the host runtime did not inject the Git author identity. Do not set Git author env vars manually; report this configuration error." >&2
  exit 1
fi

nl='
'

# Commits whose changes this commit replaces. Their co-authors stay
# credited, so an amend, rebase, cherry-pick, or squash keeps them even when
# the current run has other human actors or none.
rewritten_commits=""
add_rewritten_commit() {
  if [ -n "$1" ]; then
    rewritten_commits="$rewritten_commits $1"
  fi
}

# \`--amend\`, \`-c\`, \`-C\`, and rebase \`reword\`.
if [ "$commit_source" = "commit" ]; then
  add_rewritten_commit "$source_commit"
fi

# \`--amend -m\` and \`--amend -F\` give the "message" source, so read the
# flag from the parent \`git commit\` process.
parent_args=""
if [ -r "/proc/$PPID/cmdline" ]; then
  parent_args=$(tr '\\000' '\\n' < "/proc/$PPID/cmdline") || parent_args=""
fi
case "$nl$parent_args$nl" in
  *"$nl--amend$nl"*) add_rewritten_commit HEAD ;;
esac

git_dir=$(git rev-parse --git-dir 2>/dev/null) || git_dir=""
if [ -n "$git_dir" ]; then
  # Each rebase \`pick\` and each \`git cherry-pick\`.
  if git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null 2>&1; then
    add_rewritten_commit CHERRY_PICK_HEAD
  fi

  if [ -f "$git_dir/rebase-merge/done" ]; then
    # A rebase step that stopped on a conflict. An \`edit\` stop writes
    # \`amend\`, and a new commit there replaces no commit.
    if [ ! -f "$git_dir/rebase-merge/amend" ] && git rev-parse -q --verify REBASE_HEAD >/dev/null 2>&1; then
      add_rewritten_commit REBASE_HEAD
    fi
    # A \`fixup\` or \`squash\` folds its commit into HEAD. A rebased merge
    # reuses the commit in \`merge -C\`.
    rebase_step=$(tail -n 1 "$git_dir/rebase-merge/done")
    case "$rebase_step" in
      f\\ *|fixup\\ *|s\\ *|squash\\ *) add_rewritten_commit HEAD ;;
    esac
    case "$rebase_step" in
      f\\ *|fixup\\ *|s\\ *|squash\\ *|m\\ *|merge\\ *)
        step_commit=$(printf '%s\\n' "$rebase_step" | sed -n 's/^[a-z]* \\(-[Cc] \\)\\{0,1\\}\\([0-9a-f]\\{40,64\\}\\).*/\\2/p')
        add_rewritten_commit "$step_commit"
        ;;
    esac
  fi

  # \`git merge --squash\` lists the squashed commits in SQUASH_MSG.
  if [ "$commit_source" = "squash" ] && [ -f "$git_dir/SQUASH_MSG" ]; then
    squashed_commits=$(sed -n 's/^commit \\([0-9a-f]\\{40,64\\}\\).*/\\1/p' "$git_dir/SQUASH_MSG")
    for squashed_commit in $squashed_commits; do
      add_rewritten_commit "$squashed_commit"
    done
  fi
fi

# A rewrite keeps the author of the commit it replaces, and Git passes that
# author to this hook.
if [ "\${GIT_AUTHOR_NAME:-}" != "$JUNIOR_GIT_AUTHOR_NAME" ] || [ "\${GIT_AUTHOR_EMAIL:-}" != "$JUNIOR_GIT_AUTHOR_EMAIL" ]; then
  kept_author=""
  for rewritten_commit in $rewritten_commits; do
    rewritten_author=$(git show -s --format='%an%n%ae' "$rewritten_commit" -- 2>/dev/null) || continue
    if [ "$rewritten_author" = "\${GIT_AUTHOR_NAME:-}$nl\${GIT_AUTHOR_EMAIL:-}" ]; then
      kept_author=$rewritten_author
    fi
  done
  if [ -z "$kept_author" ]; then
    echo "GitHub plugin internal error: Git author was not set to the configured identity. Do not override Git author manually; report this configuration error." >&2
    exit 1
  fi
fi

set_coauthor_trailers() {
  awk '${SET_COAUTHOR_TRAILERS_AWK}' "$@"
}

# Existing co-authors first, then the host-derived human run actors.
coauthor_trailers=""
for rewritten_commit in $rewritten_commits; do
  rewritten_message=$(git show -s --format=%B "$rewritten_commit" -- 2>/dev/null) || continue
  coauthors=$(
    JUNIOR_COAUTHOR_LIST=1
    export JUNIOR_COAUTHOR_LIST
    printf '%s\\n' "$rewritten_message" | set_coauthor_trailers
  )
  coauthor_trailers="$coauthor_trailers$coauthors$nl"
done
coauthor_trailers="$coauthor_trailers\${JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS:-}"

message=$(
  JUNIOR_COAUTHOR_TRAILERS=$coauthor_trailers
  export JUNIOR_COAUTHOR_TRAILERS
  set_coauthor_trailers "$message_file"
)
printf '%s\\n' "$message" > "$message_file"
`;
}

// Arguments: the hooks directory, then hook name and content pairs.
// `printf '%s'` writes each hook byte for byte.
const PREPARE_GIT_SCRIPT = `set -eu
hooks_dir=$1
shift
mkdir -p "$hooks_dir"
while [ "$#" -gt 0 ]; do
  printf '%s' "$2" > "$hooks_dir/$1"
  chmod 755 "$hooks_dir/$1"
  shift 2
done
git config --global core.hooksPath "$hooks_dir"
git config --global commit.gpgsign false
git config --global credential.helper ""
git config --global http.emptyAuth true
`;

/**
 * Write Junior's Git hooks and global Git config inside the sandbox.
 *
 * This runs on every sandbox acquire, and each sandbox call is one provider
 * round trip, so all of the setup is one command.
 */
export async function prepareSandboxGit(
  ctx: SandboxPrepareHookContext,
): Promise<void> {
  const hooks = [
    ["prepare-commit-msg", prepareCommitMsgHook()],
    ...REPOSITORY_HOOK_NAMES.map((name) => [name, repositoryHook(name)]),
  ];
  const result = await ctx.sandbox.run({
    cmd: "bash",
    args: [
      "-c",
      PREPARE_GIT_SCRIPT,
      "bash",
      gitHooksPath(ctx.sandbox.juniorRoot),
      ...hooks.flat(),
    ],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to prepare sandbox git: ${result.stderr || result.stdout}`,
    );
  }
}
