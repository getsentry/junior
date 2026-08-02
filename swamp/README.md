# Swamp + Garfield (Junior dev MVP)

Local-first development automation for running a cheaper Garfield-style
review-fix-verify loop on Junior worktrees.

This is **dev tooling only**. It is not part of Junior product runtime.

## Prerequisites

```bash
curl -fsSL https://swamp-club.com/install.sh | sh
swamp --version
```

Runtime data lives in `.swamp/` and is gitignored.

## Quick start

From a Junior worktree with a meaningful dirty/committed slice:

```bash
swamp workflow run garfield-slice \
  --input goal='Harden the scheduler credential binding' \
  --input nonGoals='no product runtime changes'
```

What happens:

1. **prepare** builds `.swamp/garfield/<run>/bundle.json`, classifies lanes, and writes no-edit prompts
2. workflow **suspends** on `await-findings`
3. you (or an agent) fill `findings/*.txt`
4. resume, merge, validate, report

```bash
# inspect the suspended run
swamp workflow approvals

# after writing findings:
swamp workflow approve garfield-slice await-findings
swamp workflow resume garfield-slice
```

Final artifacts:

- `.swamp/garfield/<run>/report.md`
- `.swamp/garfield/<run>/report.json`
- `.swamp/garfield/last-run.json` pointer

## Without Swamp CLI

The deterministic spine is plain Node and can be run directly:

```bash
node scripts/garfield/build-bundle.mjs --goal '...' --run-id demo
node scripts/garfield/classify-lanes.mjs --run-dir .swamp/garfield/demo
node scripts/garfield/write-lane-prompts.mjs --run-dir .swamp/garfield/demo
# fill findings
node scripts/garfield/merge-findings.mjs --run-dir .swamp/garfield/demo
node scripts/garfield/validate.mjs --run-dir .swamp/garfield/demo --only-required
node scripts/garfield/report.mjs --run-dir .swamp/garfield/demo
```

## Reviewer protocol

Each applicable lane gets:

- `prompts/<lane>.md` — bounded no-edit instructions
- `findings/<lane>.txt` — write `none` or Garfield finding lines

Finding line format:

```text
[severity][evidence:<label[,label]> <locator>;cause:introduced|worsened|stale|missing-required] path:line - concern. impact: <impact>. fix: <smallest change>.
```

`lane-prompts.json` includes `modelHint`:

- `cheap` — narrow policy / mechanical lanes
- `strong` — behavior/spec, validation sufficiency, interface design, test quality

Repair stays in your interactive coding agent. This MVP does not auto-edit.

## Scripts

| Script | Purpose |
| --- | --- |
| `scripts/garfield/build-bundle.mjs` | Slice snapshot + validation inventory |
| `scripts/garfield/classify-lanes.mjs` | Deterministic lane applicability |
| `scripts/garfield/write-lane-prompts.mjs` | Prompt + finding stubs |
| `scripts/garfield/merge-findings.mjs` | Parse/cluster findings |
| `scripts/garfield/validate.mjs` | Targeted pnpm checks |
| `scripts/garfield/report.mjs` | `garfield: pass\|blocked` report |

## Tests

```bash
node --test scripts/garfield/lib.test.mjs
```

## Out of scope for this MVP

- auto-invoking Codex/Claude subagents
- auto-repair loops
- remote Swamp workers / `swamp serve`
- shared S3 datastore
- product-runtime integration
