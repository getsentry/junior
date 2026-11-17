# Compaction benchmark method

This file freezes the bar and the arm configs. Change them only before a
scored run, and say so in the change. `report` prints a hash of the bar,
the models, the Lore budgets and the Tier 1 and Tier 2 files, so two
reports can be compared.

The method of BYK/loreai#1211 applies: two tracks that are never pooled,
executable scoring with no LLM judge, a guessability floor, and Wilson
intervals on pass rates.

## Arms (frozen)

- `empty`: nothing. The guessability floor, shown next to every result.
- `recorded`: the summaries that production wrote.
- `removed`: all removed history. Upper bound for Tier 1 presence.
- `rerun-1..3`: today's summary prompt at points 0, 9 and 19 only.
- `distill-gpt-6-luna`: #2050's observer prompt per 16k-token segment,
  appended. Past 20 observations, the oldest merge into one meta summary.
- `lore`: the distillation chain, plus a Luna curator over each point's
  new observations that keeps up to 200 knowledge entries. Context: a
  pinned block of `constraint` and `preference` entries (2,000 tokens), a
  meta working context (2,000 tokens), and per-Turn injection of the top
  entries and observations by BM25 (3,000 tokens).
- `hybrid`: the recorded summary, the same pinned block, and per-Turn
  injection (2,000 tokens).

`lore` and `hybrid` rank with BM25 only. Lore also ranks with embeddings,
so these arms are a lower bound for Lore.

## Fairness of per-Turn injection

The injection query is the real Turn input from the event log, never the
probe question. A real Turn must get a rule without anyone asking for it.

- Tier 1: the input of the Turn that later used the fact, with the fact
  value masked, so retrieval cannot key on the answer.
- Tier 2: the first Turn input after the compaction.
- Behavioral track: the input of the replayed Turn.

## Probes and scores

Each arm answers every Tier 1 and Tier 2 probe twice: with its context
alone, and with keyword search results from the removed history (`+raw`).
Recall uses Lore's `scoreRetrieval`. A full pass needs every expected fact
and no stale fact. The report shows mean recall and full-pass rate, with a
Wilson 95% interval, overall, by age bucket and by kind.

## Bar (frozen)

An arm is WORTH IT only when every check passes. The margin is the larger
of 10 points and twice the rerun spread.

1. Tier 1 and Tier 2 recall beat `recorded` by more than the margin, with
   and without `+raw`.
2. Recall at age 5 or more is no worse than `recorded`.
3. It leaks no more stale facts than `recorded`.
4. Its extra modeled cost is at most 1.5 times the recorded summary spend.
5. Added from #1211, without changing 1 to 4: the full-pass rate beats
   `recorded` by more than the margin, and recall beats `empty` by more
   than the margin, per tier and raw setting.

The rerun spread is measured only at the points where reruns ran.

## Cost model

#2029's accounting: one cold Opus write of the replacement, then cached
reads for each recorded call of the next version, plus worker spend.

- The pinned block is part of the cached prefix.
- Per-Turn injection is a cache write once per real Turn, then cached reads
  for that Turn's later calls. Turn and call counts come from the log.
- Worker spend: `lore` is distill + curator + meta; `hybrid` is the
  recorded summary + distill + curator. All at Luna prices.

## Behavioral track

For the first real Turn after each compaction (`--behavior-turns N` for
more), the replay builds Junior's system prompt and tool definitions with
the production builders. The context is the arm's block in the production
summary wrapper, then the kept tail and later history as production had
it, then the real Turn input. One Opus Turn runs for up to 8 calls.

Every tool is stubbed. A call that matches a recorded call by name and
arguments gets the recorded result; others get a canned result. Nothing
reaches GitHub, Slack or anything else. A deterministic checker scores the
tool calls against standing rules from `tier2.json`. A rule applies at a
Turn only when a Tier 2 constraint has stated it by that point, and the
real Turn's input asks for an action that the rule governs, or the real
Turn did one. Elsewhere it is n/a.

| Rule | Pass | Fail |
| --- | --- | --- |
| `merge-main-not-rebase` | merges `main` | rebases onto `main`, `pull --rebase` |
| `push-ancestor-check-and-lease` | `merge-base --is-ancestor` before push | no check, `--force`, `--no-verify` |
| `review-card-before-public-write` | `addReviewItem` before the write | write first |
| `never-merge-prs` | no merge in a finished Turn | any PR merge |
| `no-self-matching-pkill` | bracket pattern | `pkill -f` or `pgrep -f` without one |
| `no-via-byk-in-pr-body` | PR body without it | "via @BYK" in a PR body |
| `pr-body-via-github-tool` | `github_updatePullRequest` | `gh pr edit` |
| `review-card-assignee` | every card assigns burak.kaya@sentry.io | a card without it |
| `noreply-alone` | `noReply` is the only call in its message | `noReply` with other calls |

A rule with no governed action in the Turn is inconclusive, not a pass.
The review-card rule is n/a when the Turn input is a review-item answer,
since that answer can be the approval. A
"never" rule in a Turn that hit the call cap is inconclusive. The report
counts pass, fail and inconclusive per rule and arm, and gives the pass
rate of decided outcomes. It is never pooled with recall.

Limits: the system prompt and tools are today's, not those of Nov 9-14.
Only the GitHub plugin is loaded. Triggers are keyword heuristics.

## Experiments 1 and 2 (frozen before their run)

Experiment 1 keeps a smaller raw tail: the newest 32k or 64k estimated
tokens of production's tail. The rest joins the removed history. Each point
keeps production's state from before it and compacts once with the smaller
tail. Arms at each tail: `empty`, `recorded` (production's summary, which
already saw the whole history), the Luna chain, and the experiment 2 arms.
`summary-removed` runs today's `SUMMARY_INSTRUCTION` over the removed
history alone, at points 0, 4, 9, 14 and 19 only.

Tier 1 is mined again per tail. Tier 2 keeps the approved items whose
source is in the removed history at that tail. The miner read only
production's removed history, which a smaller tail only grows, so an item
without cited seqs qualifies; an item that cites seqs qualifies when every
cited seq is before the kept tail.

Experiment 2 reshapes the Luna distiller, consolidation and curator prompts
to the summary's sections. Constraints and preferences stay pinned.

Cost: the total modeled prompt of every recorded call in the next version,
shifted by each arm's replacement and kept tail. The verdict replaces the
summary-spend check with "total cost no higher than today's" (production
tail plus recorded summary). The recall checks compare with `recorded` at
the same tail, and with `summary-removed` on its five points.
