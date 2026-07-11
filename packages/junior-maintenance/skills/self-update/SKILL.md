---
name: self-update
description: Update this junior-prod app to the latest published Junior release. Use when asked to self-update Junior, bump @sentry/junior and @sentry/junior-* dependencies, run safety checks, and open a draft PR.
---

## Workflow

### 1. Preflight

```bash
git status --short
git branch --show-current
```

Stop if `package.json`, `pnpm-lock.yaml`, or `pnpm-workspace.yaml` has unrelated uncommitted changes.

### 2. Inventory and target

Inventory direct Junior deps from `package.json`: `@sentry/junior` and `@sentry/junior-*`. Record package, current exact version, and dependency section. Keep all Junior deps on one version and do not move packages between sections.

Resolve the target:

```bash
pnpm view @sentry/junior dist-tags.latest
```

If user requests a specific version, use that. If already on latest, stop.

Verify the target exists for every inventoried package before mutating files:

```bash
pnpm view <package>@<target> version
```

Stop if any package lacks the target on npm.

### 3. Build release context

Junior does not publish GitHub releases, tags, or a changelog. Use npm publish timestamps to summarize merged PRs between `old_version` and `target_version`:

```bash
pnpm view @sentry/junior time --json
gh pr list --repo getsentry/junior --state merged \
  --search "merged:>=<old_published_at> merged:<=<target_published_at>" \
  --limit 100 \
  --json number,title,url,mergedAt
```

Save total PR count, breaking PRs (`!` or `BREAKING CHANGE`), and config-relevant PRs (`config`, `plugins`, `nitro`, `createApp`, `runtime`, `credentials`, `egress`, `example`). If any breaking PR exists, keep the PR draft and call out manual review, but continue the update.

### 4. Create or reuse branch

`build/update-junior-<target>`. All file mutations happen on this branch.

### 5. Sync `minimumReleaseAgeExclude`

If `pnpm-workspace.yaml` has a `minimumReleaseAgeExclude` list, ensure every Junior package from step 2 is covered by an exact entry or an existing package pattern. Add missing entries before `pnpm add`, but do not add exact entries already covered by `@sentry/*`. Append at end and preserve existing order.

### 6. Update deps (section-preserving)

Group `pnpm add` by dependency section:

```bash
pnpm add -E <deps-packages>@<target> ...
pnpm add -D -E <devDeps-packages>@<target> ...
pnpm add -O -E <optDeps-packages>@<target> ...
```

Do not manually edit versions in `package.json`. Do not use local `../junior` linking scripts.

### 7. Sync local config

If a new standalone `@sentry/junior-*` plugin package was added, list it in `juniorNitro({ plugins.packages })`. Exclude the base/runtime utility packages: `@sentry/junior`, `@sentry/junior-plugin-api`, `@sentry/junior-testing`.

```bash
node scripts/check-plugin-packages.mjs
```

Compare the consumer config with `apps/example` at `target_ref` to catch shape drift. Choose `target_ref` from the version bump commit, then the publish timestamp, then `origin/main` as approximate:

```bash
git clone --filter=blob:none --depth=200 https://github.com/getsentry/junior.git /tmp/junior-upstream
git -C /tmp/junior-upstream log --oneline -S'"version": "<target_version>"' -- packages/junior/package.json
git -C /tmp/junior-upstream rev-list -n 1 --before="<target_published_at>" origin/main
git -C /tmp/junior-upstream checkout <target_ref>
git diff --no-index -- /tmp/junior-upstream/apps/example/nitro.config.ts nitro.config.ts
git diff --no-index -- /tmp/junior-upstream/apps/example/plugins.ts plugins.ts
git diff --no-index -- /tmp/junior-upstream/apps/example/server.ts server.ts
```

Ignore app-local values. Apply only obvious low-risk fixes; put ambiguous drift in the PR body. For `package.json`, compare only build tooling (`nitro`, `jiti`, `typescript`), not plugin dependency lists or pins.

For `vercel.json`, do not normalize the whole file against the example. Use upstream diff-backed changes when possible:

```bash
git -C /tmp/junior-upstream diff <old_ref>..<target_ref> -- apps/example/vercel.json
```

Only act on Junior-owned deployment requirements proven by that diff or by release-window PRs/docs. If `old_ref` is unavailable, target-only example entries are context, not proof; mark the review approximate and leave a manual review item when needed.

### 8. Verify

```bash
git diff --name-only
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm build
```

Expected changed files: `package.json`, `pnpm-lock.yaml`, optional `pnpm-workspace.yaml`, optional `nitro.config.ts`, optional `vercel.json`. Confirm every Junior dep is exactly `<target>`. If the frozen install fails, repair with `pnpm install --lockfile-only` and rerun. Fix update-related check failures; disclose pre-existing or environment failures.

### 9. Commit

```text
build(deps): Update Junior packages to <target>

Update the Junior runtime and plugin packages to <target> and refresh the pnpm lockfile.
```

Mention `minimumReleaseAgeExclude` sync if `pnpm-workspace.yaml` changed.

### 10. Push and open/update draft PR

Open a draft PR. Include version change, release-window summary with the no-changelog disclaimer, config comparison findings, optional workspace/plugin/vercel changes, check results, and unexpected diffs. Add **Manual review required** when breaking PRs, unresolved config drift, approximate Vercel review, or failed checks exist.

## Stop conditions

- Any Junior package lacks the target version on npm.
- `pnpm install --frozen-lockfile` fails after repair.
- Checks fail for non-pre-existing, non-environment reasons and no safe config fix is available from step 7.
- `package.json` changed but `pnpm-lock.yaml` did not.
- Example app comparison reveals a breaking plugin signature change whose required values cannot be inferred from the existing consumer config.
