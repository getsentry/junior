# Handoff experiment

## Hypothesis

The handoff summary can select old maintenance instructions over a terse new
cleanup request. The summary input appends historical thread context after the
current request. That context contains a rule to stay silent. Handoff then
replaces the authored request with the generated summary.

Runtime context is stripped from history before summarization. This may remove
useful memory, but we have not proved that it removed the definition in the
production failure. Memory in the continuation does not establish what the
summarizer saw. This experiment tests task selection, not that narrower claim.

`handoff.eval.ts` compares `Deslop` with an explicit cleanup request. Both use
the same history, memory, source file, and configured model defaults. The
meaning of `Deslop` is seeded through the real memory store. It is not explained
in prior messages. Recall, routing, handoff, summary, and continuation are live.
Both requests start with `Switch to the standard profile first.`. This is a
requested handoff, not the spontaneous handoff from the production failure.

The fixture source has a class and factory that only wrap stable ID generation.
The request must remove those wrappers through a successful source edit after
handoff. A promise or a reply without an edit does not pass.

## Interpret the result

- No handoff: inconclusive for task loss. Inspect the route before another run.
- No memory recall: the terse request has no defined meaning in this setup.
- Handoff followed by silence or maintenance work: candidate reproduction.
  Inspect the saved summary before attributing the failure to summarization.
- Terse request fails while explicit request completes: inspect both routes.
  Different routes are not a controlled comparison of summarization. If both
  hand off, compare summaries before claiming evidence for lost task meaning.
- Both complete: reject this small case as a reproduction. Do not call it a fix.
- Both fail: inspect setup and the actual summary before changing the fixture.

Do not retry just to obtain a failure. A later experiment must name the new
hypothesis and keep the other inputs fixed. A runtime fix is a separate control:
the same failing input must complete after the fix.

## Runs

### Pair 1: direct cleanup request

Commit: `860a61a76`.
[CI run](https://github.com/getsentry/junior/actions/runs/36171352735).

Both cases routed directly to the handoff profile (`anthropic/claude-opus-5.5`,
high reasoning). Neither called `handoff`. Both removed the wrappers through
`editFile`. The terse case recalled the definition. The explicit case did not.
The assertions correctly failed because no handoff occurred. This is not a
reproduction and gives no evidence about live summary task selection.

### Pair 2: request a model switch

Keep the history, source file, memory seed, and model defaults fixed. Add the
same `Switch models first.` prefix to both requests. The first pair established
that ordinary routing avoids the boundary we need to test. The prefix asks the
live agent to enter that boundary without injecting a tool call or summary.
The hypothesis remains that the terse task loses priority during summarization.
Do not interpret routing failure or a tool timeout as task substitution.

Commit: `311c4b9bc`.
[CI run](https://github.com/getsentry/junior/actions/runs/36172657682).
Both routed to the handoff profile. The terse case recalled the definition,
skipped handoff, and edited the source. The explicit control did not recall
memory. It called handoff to standard and then back to handoff. Both live
summaries retained the cleanup task. It completed the source edit and passed.
This is not a reproduction or a controlled summary comparison.

### Pair 3: name the destination profile

Replace the shared prefix with `Switch to the standard profile first.`. Keep
all other inputs fixed. Pair 2 showed that the vague request did not reliably
reach handoff, while a successful standard-profile switch was available to the
other case. Naming the destination removes that ambiguity. This checks the
setup needed to test task loss. Do not infer task loss if it still skips handoff.
Do not repeat this case merely to obtain a failing summary.

## Limits

This is a reduced coding task, not an exact replay. Prior maintenance text uses
bot-authored Slack history fixtures, not the original system-event provenance.
The model defaults differ from the original production model configuration.
The fixture has no long tool history. These differences remain possible causes
if the small case does not fail.

CI currently runs the integration suite on changes to this folder. Each push
runs this pair once. Do not rerun the suite without reviewing the first result.
