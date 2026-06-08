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

### 2. Inventory deps

Collect direct Junior deps from `package.json` — `@sentry/junior` and names starting with `@sentry/junior-`. Record each package's name, current version, and dependency section (`dependencies` / `devDependencies` / `optionalDependencies`). All must be pinned to the same exact version. Do not move packages between sections.

### 3. Resolve target

```bash
pnpm view @sentry/junior dist-tags.latest
```

If user requests a specific version, use that. If already on latest, stop.

Verify the target exists for every inventoried package before mutating files:

```bash
pnpm view <package>@<target> version
```

Stop if any package lacks the target on npm.

### 3b. Build Junior release context

Junior does not publish GitHub releases, git tags, or a CHANGELOG. Build a best-effort release summary to guide the update and populate the PR body.

1. Note `old_version` (current `@sentry/junior` from step 2) and `target_version` (from step 3).

2. Fetch npm publish timestamps:

   ```bash
   pnpm view @sentry/junior time --json
   ```

   Extract `old_published_at` and `target_published_at` from the result.

3. Query merged PRs in `getsentry/junior` between those timestamps:

   ```bash
   gh pr list --repo getsentry/junior --state merged \
     --search "merged:>=<old_published_at> merged:<=<target_published_at>" \
     --limit 100 \
     --json number,title,url,mergedAt
   ```

4. Classify the results:
   - **Breaking:** PR titles matching `^[a-z]+([^)]*)!:` (conventional-commit `!` marker), or body containing `BREAKING CHANGE`.
   - **Config-relevant:** titles/scopes mentioning `config`, `plugins`, `nitro`, `createApp`, `runtime`, `credentials`, `egress`, or `example`.

5. Save a compact summary — total PR count, breaking PRs (title + URL), config-relevant PRs — for the PR body. Do not list every fix/chore PR.

6. If breaking PRs are found, flag the update as needing manual review in the PR body and keep the PR draft. Do **not** abort the update — proceed and let checks and the config comparison (step 6c) surface concrete issues.

### 4. Create or reuse branch

`build/update-junior-<target>`. All file mutations happen on this branch.

### 5. Sync `minimumReleaseAgeExclude`

If `pnpm-workspace.yaml` has a `minimumReleaseAgeExclude` list, ensure every Junior package from step 2 is listed. Add missing entries before `pnpm add`. Append at end, preserve existing order.

### 6. Update deps (section-preserving)

Group `pnpm add` by dependency section:

| Section | Flag |
|---------|------|
| `dependencies` | `-E` |
| `devDependencies` | `-D -E` |
| `optionalDependencies` | `-O -E` |

```bash
pnpm add -E <deps-packages>@<target> ...
pnpm add -D -E <devDeps-packages>@<target> ...   # if any
pnpm add -O -E <optDeps-packages>@<target> ...    # if any
```

Do not manually edit versions in `package.json`. Do not use local `../junior` linking scripts.

### 6b. Sync `nitro.config.ts` plugin packages

After updating deps, check whether any **new** `@sentry/junior-*` packages were added (i.e. present in the new `package.json` but absent before the update). For each newly added package, ensure it is also listed in the `plugins.packages` array inside `juniorNitro({...})` in `nitro.config.ts`.

**Packages that are NOT standalone plugins and do NOT need a `plugins.packages` entry:**
- `@sentry/junior` (the base runtime)
- `@sentry/junior-plugin-api` (plugin development utilities)
- `@sentry/junior-testing` (test utilities)

For every other newly added `@sentry/junior-*` package, add it to `nitro.config.ts` if missing:

```typescript
// nitro.config.ts — append the new package to plugins.packages
juniorNitro({
  plugins: { packages: [
    // ... existing entries ...
    "@sentry/junior-<new-package>",  // ← add here
  ] },
})
```

Verify by running:

```bash
node scripts/check-plugin-packages.mjs
```

This must exit 0 before proceeding. If it fails, fix `nitro.config.ts` and rerun.

### 6c. Compare consumer config against the Junior example app

After updating deps, compare this app's configuration files against `apps/example/` in `getsentry/junior` for the target version. Goal: catch config-shape drift before checks run.

1. Clone `getsentry/junior` into a temp directory (skip if already present from a prior run):

   ```bash
   git clone --filter=blob:none --depth=200 https://github.com/getsentry/junior.git /tmp/junior-upstream
   cd /tmp/junior-upstream
   ```

2. Select the best source ref for `target_version`:

   a. Try to find the version-bump commit:
      ```bash
      git log --oneline -S'"version": "<target_version>"' -- packages/junior/package.json
      ```
      If found, check out that commit.

   b. If not found, find the commit just before the npm publish timestamp:
      ```bash
      git rev-list -n 1 --before="<target_published_at>" origin/main
      ```
      If found, check out that commit.

   c. If neither works, use `origin/main` — mark the comparison as approximate in the PR body.

3. Run focused diffs between example app and consumer app:

   ```bash
   git diff --no-index -- /tmp/junior-upstream/apps/example/nitro.config.ts nitro.config.ts
   git diff --no-index -- /tmp/junior-upstream/apps/example/plugins.ts plugins.ts
   git diff --no-index -- /tmp/junior-upstream/apps/example/server.ts server.ts
   ```

4. Interpret the diffs structurally. Look for changes in:
   - `juniorNitro()` option shape (new/removed/renamed options)
   - `defineJuniorPlugins([...])` usage or call convention
   - Plugin factory call signatures (e.g. `githubPlugin({ ... })`)
   - `createApp({ ... })` option keys
   - Required support devDeps (`nitro`, `jiti`, `typescript`)

   **Ignore** app-local differences: env var names, local plugin/skill registrations, custom config defaults, SOUL/WORLD content, Slack personality settings.

5. Apply only obvious, low-risk fixes automatically — e.g. updating a renamed option key or adding a required new argument when the value is inferrable. For everything else, add a PR-body action item.

6. For `package.json`, compare only the build tooling (`nitro`, `jiti`, `typescript`) — do not copy the example's plugin dep list or version pins.

7. Save findings and any actions taken for the PR body.

### 7. Verify lockfile correctness

1. Check changed files:
   ```bash
   git diff --name-only
   ```
   Expected: `package.json`, `pnpm-lock.yaml`, optionally `pnpm-workspace.yaml`, and optionally `nitro.config.ts` if plugin registration changed in step 6b. Flag anything else.

2. Confirm every Junior dep in `package.json` shows exact `<target>` — no old versions remain.

3. Prove lockfile agrees with package.json:
   ```bash
   pnpm install --frozen-lockfile
   ```
   If this fails, repair with `pnpm install --lockfile-only` then rerun. Stop if still broken.

### 8. Run checks

```bash
pnpm check
pnpm typecheck
pnpm build
```

Classify failures: update-related → fix before PR; pre-existing or environment → capture in PR and disclose. Do not silently skip failed checks.

### 9. Commit

```text
build(deps): Update Junior packages to <target>

Update the Junior runtime and plugin packages to <target> and refresh the pnpm lockfile.
```

Mention `minimumReleaseAgeExclude` sync if `pnpm-workspace.yaml` changed.

### 10. Push and open/update draft PR

PR body sections (in order):

1. **Version change** — old → new, package list with sections.
2. **Junior release window** — total PR count, breaking PRs (title + URL), config-relevant PRs. Sourced from step 3b. Include the disclaimer: _Junior does not publish GitHub releases, tags, or a changelog. This summary is derived from npm publish timestamps and merged PRs._
3. **Example app config comparison** — source ref used (commit SHA or approximate), files compared, findings, actions taken. Sourced from step 6c.
4. **`minimumReleaseAgeExclude` changes** (if any).
5. **`nitro.config.ts` plugin registration changes** (if any).
6. **Check results** — pass/fail per check, pre-existing failures noted.
7. **Unexpected diffs** — any changed files beyond `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `nitro.config.ts`.

If breaking PRs were found in step 3b, or config comparison found unresolved drift, or checks failed — keep the PR as draft and add a "Manual review required" section at the top summarizing blockers.

## Stop conditions

- Any Junior package lacks the target version on npm.
- `pnpm install --frozen-lockfile` fails after repair.
- Checks fail for non-pre-existing, non-environment reasons and no safe config fix is available from step 6c.
- `package.json` changed but `pnpm-lock.yaml` did not.
- Example app comparison reveals a breaking plugin signature change whose required values cannot be inferred from the existing consumer config.
