# Swamp + Garfield (Junior dev)

Local-first development automation for running a cheaper Garfield-style
review-fix-verify loop on Junior worktrees.

This is **dev tooling only**. It is not part of Junior product runtime.

## Default path: agent owns the loop

Tell the coding agent to run Garfield. It should prepare, review, fix, validate,
and report without asking you to fill findings files.

```bash
# agent runs this
node scripts/garfield/run.mjs --goal 'Harden the scheduler credential binding' \
  --non-goal 'no product runtime changes'

# agent reviews lanes, writes findings, fixes issues, then:
node scripts/garfield/run.mjs --finalize
```

What `run.mjs` does:

1. **prepare** — bundle + core lane plan + prompts + `agent-brief.md`
2. **agent judgment** — review each applicable lane, write `findings/*.txt`, fix
3. **finalize** — merge findings, run targeted validation, emit `garfield: pass|blocked`

Skill entrypoint for agents: `skills/garfield/SKILL.md`.

### Profiles

| Profile | Behavior |
| --- | --- |
| `core` (default) | Always-on + matched native lanes. Source-app policies deferred to repository-instructions. |
| `full` | Also opens one lane per `policies/*.md`. |

```bash
node scripts/garfield/run.mjs --goal '...' --profile full
```

## Optional: Swamp human-gated path

If you want a suspend/approve workflow instead of an agent-owned loop:

```bash
curl -fsSL https://swamp-club.com/install.sh | sh
swamp --version

swamp workflow run garfield-slice \
  --input goal='Harden the scheduler credential binding' \
  --input nonGoals='no product runtime changes'
```

1. **prepare** builds `.swamp/garfield/<run>/`
2. workflow **suspends** on `await-findings`
3. fill `findings/*.txt` manually (or with a separate reviewer)
4. resume:

```bash
swamp workflow approve garfield-slice await-findings
swamp workflow resume garfield-slice
```

Runtime data lives in `.swamp/` and is gitignored.

## Artifacts

- `.swamp/garfield/<run>/agent-brief.md` — what the agent must do next
- `.swamp/garfield/<run>/agent-todo.json` — machine-readable lane queue + commands
- `.swamp/garfield/<run>/report.md` / `report.json`
- `.swamp/garfield/last-run.json` pointer

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

## Scripts

| Script | Purpose |
| --- | --- |
| `scripts/garfield/run.mjs` | **Preferred** agent prepare + finalize |
| `scripts/garfield/build-bundle.mjs` | Slice snapshot + validation inventory |
| `scripts/garfield/classify-lanes.mjs` | Deterministic lane applicability |
| `scripts/garfield/write-lane-prompts.mjs` | Prompt + finding stubs |
| `scripts/garfield/merge-findings.mjs` | Parse/cluster findings |
| `scripts/garfield/validate.mjs` | Targeted pnpm checks |
| `scripts/garfield/report.mjs` | `garfield: pass\|blocked` report |

## Direct spine (no run.mjs wrapper)

```bash
node scripts/garfield/build-bundle.mjs --goal '...' --run-id demo
node scripts/garfield/classify-lanes.mjs --run-dir .swamp/garfield/demo --profile core
node scripts/garfield/write-lane-prompts.mjs --run-dir .swamp/garfield/demo
# agent writes findings
node scripts/garfield/merge-findings.mjs --run-dir .swamp/garfield/demo
node scripts/garfield/validate.mjs --run-dir .swamp/garfield/demo --only-required
node scripts/garfield/report.mjs --run-dir .swamp/garfield/demo
```

## Tests

```bash
node --test scripts/garfield/lib.test.mjs
# or
pnpm garfield:test
```

## Out of scope (still)

- auto-spawning separate Codex/Claude subagent processes
- remote Swamp workers / `swamp serve`
- shared S3 datastore
- product-runtime integration
