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

PR body: version change, package list with sections, `minimumReleaseAgeExclude` changes, `nitro.config.ts` plugin registration changes (if any), check results, unexpected diffs.

## Stop conditions

- Any Junior package lacks the target version on npm.
- `pnpm install --frozen-lockfile` fails after repair.
- Checks fail for non-pre-existing, non-environment reasons.
- `package.json` changed but `pnpm-lock.yaml` did not.
