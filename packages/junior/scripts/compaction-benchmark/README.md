# Compaction benchmark

Offline benchmark of compaction retention on one long session. It reads an
event-log export at run time and rebuilds the history before each recorded
capacity compaction. It compares today's summary with other arms on the
facts that later Turns needed, and on modeled cost.

Fixtures and results stay out of git. `run.ts` refuses a data directory
inside a Git work tree. `METHOD.md` holds the method, the frozen bar and
the frozen arm configs.

## Data

`D` is the unpacked export directory: `events.jsonl` after `merge`, plus
`tier1.json`, `tier2.json`, `arms/`, `lore/`, `probes.json`,
`behavior.json`, `report.md`, `behavior.md` and `cache/`.

## Quick start

Run from `packages/junior` with `AI_GATEWAY_API_KEY` set.

```sh
pnpm exec tsx scripts/compaction-benchmark/run.ts all --data $D
pnpm exec tsx scripts/compaction-benchmark/run.ts all --continue --data $D
```

The first command runs the free stages, prints a dry-run estimate, mines
Tier 2, and stops so a person can review `$D/tier2.json`. The second runs
the Luna distillation, three summary reruns at points 0, 9 and 19, the
probes and the report.

### New arms and the behavioral track

```sh
R="pnpm exec tsx scripts/compaction-benchmark/run.ts"
$R all --arms lore,hybrid --behavior --dry-run --data $D
$R all --arms lore,hybrid --behavior --data $D --max-usd 90
```

This reuses `tier2.json` and the cache, and makes only the new calls: the
`lore` stage (curator and meta calls), the probes of `lore` and `hybrid`,
and the behavioral replays. Drop `--behavior` for the recall arms alone,
or drop `--arms` for the behavioral track alone.

`--max-usd` caps the total spend in `$D/cache`, including earlier runs. It
defaults to 30. Set it to the spend so far plus the estimate. A run stops
before a call that would pass the cap and exits with code 3. Results are
cached by content hash, so the same command resumes.

Set `OPENROUTER_API_KEY` and pass `--provider openrouter` to send the same
model ids through OpenRouter. Cache keys include the provider, so a cache
made on one provider is reused only on that provider.

## Stages

| Stage | Command | Model |
| --- | --- | --- |
| Merge the export | `$R merge --data $D` | none |
| Rebuild compaction points | `$R rebuild --data $D` | none |
| Mine Tier 1 facts | `$R tier1 --data $D` | none |
| Tier 1 presence and modeled cost | `$R score --data $D` | none |
| Behavioral rules and where they apply | `$R rules --data $D` | none |
| Mine Tier 2 probes | `$R tier2 --data $D --max-usd 15` | Opus |
| Distillation arm | `$R distill --data $D --max-usd 5` | Luna |
| Summary reruns | `$R rerun-summary --runs 3 --points 0,9,19 --data $D --max-usd 10` | Opus |
| Lore and hybrid arms | `$R lore --data $D --max-usd N` | Luna |
| Probe answers | `$R probe [--arms lore,hybrid] --data $D --max-usd N` | Luna |
| Behavioral replays | `$R behavior --data $D --max-usd N` | Opus |
| Report | `$R report --data $D` | none |

Model stages run alone need `--max-usd` and take `--dry-run`. To compare
another distiller later, pass its model id with `--model`.

Lore budgets: `--pinned-tokens` (2000), `--meta-tokens` (2000),
`--lore-inject-tokens` (3000) and `--hybrid-inject-tokens` (2000).
Behavioral options: `--behavior-arms` (empty, recorded,
distill-gpt-6-luna, lore, hybrid), `--behavior-points`, and
`--behavior-turns` (1: replay the first real Turn after each compaction).
Changing any of these after a scored run breaks the freeze in `METHOD.md`.
