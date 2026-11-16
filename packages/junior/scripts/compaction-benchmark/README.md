# Compaction benchmark

Offline benchmark that compares today's capacity compaction summary with
Lore-style distillation on one real, long Conversation. It replays the
event log, cuts the history at each recorded `compaction`, and scores what
each arm keeps of the facts that later Turns needed.

The data directory holds Conversation content. Keep it outside git. The
script refuses a data directory inside a git work tree. Do not commit,
post, or attach its files.

## Data

The data directory holds an export made with the agent conversation tools:

- `pages/*.json`: `searchConversationEvents` pages, 100 events each.
- `payloads/*.jsonl`: one `readConversationEvent` result per line, for
  events whose page entry has `payload_omitted`.

`merge` writes `events.jsonl` and fails while a payload that the benchmark
reads is missing.

Known gap: after the first compaction, rebuilt counts are one entry
below the recorded `inputMessageCount`. The export reports only a count
for the replacement history, and the rebuild adds back only the summary.

## Quick start

Run from `packages/junior` with `AI_GATEWAY_API_KEY` set. `D` is the
unpacked export directory.

```sh
pnpm exec tsx scripts/compaction-benchmark/run.ts all --data $D
pnpm exec tsx scripts/compaction-benchmark/run.ts all --continue --data $D
```

The first command runs the free stages (merge, rebuild, tier1, score),
prints a dry-run estimate for every model stage, mines Tier 2, and stops.
Review `$D/tier2.json` and fix or delete wrong items. The second command
runs the Luna distillation, three summary reruns at points 0, 9, and 19,
the probes, and the report.

`--max-usd` caps the total spend in `$D/cache` across both commands. It
defaults to 30. `all --dry-run --data $D` prints only the estimate. A run
stops before a call that would pass the cap and exits with code 3. Results
are cached by content hash, so the same command resumes. An existing
`tier2.json` is never overwritten; a new mine goes to `tier2.mined.json`.

## Stages

Each stage also runs alone. Set `R="pnpm exec tsx scripts/compaction-benchmark/run.ts"`.

| Stage | Command | Model |
| --- | --- | --- |
| Merge the export | `$R merge --data $D` | none |
| Rebuild compaction points | `$R rebuild --data $D` | none |
| Mine Tier 1 facts | `$R tier1 --data $D` | none |
| Tier 1 presence and modeled cost | `$R score --data $D` | none |
| Mine Tier 2 probes | `$R tier2 --data $D --max-usd 15` | Opus |
| Distillation arm | `$R distill --data $D --max-usd 5` | Luna |
| Summary reruns | `$R rerun-summary --runs 3 --points 0,9,19 --data $D --max-usd 10` | Opus |
| Probe answers | `$R probe --data $D --max-usd 10` | Luna |
| Report | `$R report --data $D` | none |

Model stages run alone need `--max-usd` and take `--dry-run`. Luna is the
distiller. To compare another text model later, pass its Gateway model id
with `--model`; the arm is named after the id.

## Arms

- `empty`: nothing. Lower bound.
- `recorded`: the summaries that production wrote. No model cost here; the
  cost is the recorded `compaction_prepared` spend.
- `removed`: all removed history. Upper bound.
- `rerun-N`: today's `SUMMARY_INSTRUCTION` on rebuilt history, for spread.
- `distill-gpt-6-luna`: #2050's observer prompt per 16k-token segment,
  appended across compactions. Past 20 observations, the oldest merge
  into one meta summary.

`probe` asks each arm every Tier 1 and Tier 2 question twice: with the
arm's context alone, and with keyword search results from the removed
history. Junior's event search has no text query, so the second setting is
an upper bound for the raw tier.

## Scores

- Tier 1: identifiers (PRs, SHAs, UUIDs, paths, URLs, agent names) that
  the agent used after a compaction before the new version showed them,
  and that only removed history held.
- Tier 2: model-mined open asks, assignments, queued briefs, decisions, and
  constraints, checked by a person.
- Recall uses Lore's `scoreRetrieval`. Age is the number of compactions
  since the fact first appeared. Leaks count superseded values.
- Modeled cost follows #2029: one cold Opus write of the replacement, then
  cached reads for each recorded call in the next version, plus worker
  spend.

`report` prints WORTH IT only when a distillation arm beats `recorded` by
more than 10 points and twice the rerun spread on Tier 1 and Tier 2, with
and without search, does no worse at age 5 or more, leaks no more, and
costs at most 1.5 times the recorded summary spend.
