# Handoff experiment

## Hypothesis

The handoff summary can select old maintenance instructions over a terse new
cleanup request. The summary input appends historical thread context after the
current request. That context contains a rule to stay silent. Handoff then
replaces the authored request with the generated summary.

Runtime context is stripped from history before summarization. The production
summarizer input included recalled memory that defined `Deslop`. Missing meaning
is not an established cause of that failure. This experiment tests task selection,
not whether memory was absent.

`handoff.eval.ts` compares `Deslop` with an explicit cleanup request. Both use
the same history, memory, source file, and configured model defaults. The
meaning of `Deslop` is seeded through the real memory store. It is not explained
in prior messages. Recall, routing, handoff, summary, and continuation are live.
Both requests ask to switch to the other configured profile first. This is a
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

Commit: `bb99f7808`.
[CI run](https://github.com/getsentry/junior/actions/runs/36174341591).
The run logs and `integration-evals-1` result artifact show:

- Both cases routed to `anthropic/claude-opus-5.5` with high reasoning. Both
  called handoff to standard and then back to handoff. The live summarizer was
  `openai/gpt-6-luna`.
- The terse case recalled the definition. Both summaries omitted the cleanup
  request. They selected the earlier stable-ID implementation task, not the
  PR-maintenance task or its silence rule. This differs from production.
- Despite that task loss, the terse continuation used `editFile` to remove the
  class and factory. It then reached the 60-second deadline. Slack received an
  internal-error reply, not `[[NO_REPLY]]`. The case failed after 60.7 seconds.
- The explicit control did not recall memory. Both summaries kept the cleanup
  request. It removed the wrappers, replied, and passed after 57.4 seconds.

This proves live summary task loss in the reduced case. It does not reproduce
silent abandonment. The source edit disproves the narrower claim that this
continuation abandoned the cleanup. The timeout does not establish that summary
loss caused the incomplete turn. Recall also differed between cases, so this is
not a controlled test of summary wording alone.

The component regression on this commit also failed:
[`agent-run-model-handoff.test.ts`](https://github.com/getsentry/junior/actions/runs/36174341284/job/108201350562).
Its resumed input contains the scripted old maintenance summary instead of the
expected authored `Deslop` instruction. This proves the runtime replacement
behavior, not a live model's decision to remain silent.

### Pair 4: include the completed implementation in agent history

Keep the requests, memory seed, source file, visible Slack history, model defaults,
and assertions from pair 3. Add only the earlier source-write call and its success
result to preloaded agent history. The written content comes from the same fixture
file that the continuation will inspect. It does not say that cleanup happened.

Hypothesis: missing tool history made the earlier coding task appear unfinished.
Both terse summaries in pair 3 explicitly called the prior implementation
unverified and asked the continuation to inspect it. That inspection led to a
cleanup edit despite the missing request. The production summary instead recorded
implemented changes and completed checks, then selected PR maintenance.

This pair tests whether evidence of completed work removes that recovery path.
The new cleanup must still happen after a live handoff. A summary that retains the
cleanup, a continuation that completes it anyway, a skipped handoff, or a timeout
does not reproduce silent abandonment. No summary or continuation is scripted.
The explicit-request case remains the control. This is still a reduced fixture,
not a replay of the full production tool history.

Commit: `b9ad446d5`.
[CI run](https://github.com/getsentry/junior/actions/runs/36177662562).
The terse case routed to standard, recalled the definition, made no handoff, and
completed cleanup in 45 seconds. The explicit control routed to handoff, switched
to standard, and passed in 42 seconds. Its live summary recognized the prior write
and kept the new cleanup task. The terse case did not reach the boundary under
test, so this run cannot test the hypothesis about completed tool work.

### Pair 5: request the other configured profile

Change only the common switch prefix to `Switch to the other configured profile
first.`. The fixed standard destination becomes a no-op when the router selects
standard, as pair 4 demonstrated. Asking for the other profile makes the switch
meaningful for either route. Keep all remaining input and assertions unchanged.
This is a setup correction, not new evidence for the task-loss hypothesis. The
model must still choose and call handoff; no live model response is scripted.

Commit: `068359623`.
[CI run](https://github.com/getsentry/junior/actions/runs/36179191521).
Both cases recalled memory, handed off, and completed cleanup. The terse case
routed from standard to handoff and passed in 57.9 seconds. Its summary demoted
`Deslop` to a preference, but asked the continuation to inspect prior work. The
explicit control switched twice and passed in 58.9 seconds. This is not a
reproduction.

The terse summary identified contradictions in our fixture: it used `writeFile`
after an `editFile` request, had no verification result, and claimed a PR and
delivery logs despite the local-only work. The continuation corrected those
claims and simplified the file. Those are valid reasons to reopen the old task.

### Pair 6: correct the completed-work fixture

Hypothesis: the fixture's incomplete or contradictory prior work supplies a
recovery path after summary task loss. Production had completed edits and checks.
Correct the fixture to use the requested `editFile`, include a Node verification
result, and remove unsupported claims about a PR and delivery logs. The edit
changes thread-dependent IDs to stable IDs. It does not remove the wrappers.
The verification command was run locally against the fixture and passed.

Keep the new requests, source file, memory seed, model defaults, maintenance
events, and assertions unchanged. The summary and continuation remain live. A
normal completion without cleanup after a successful handoff is the target
failure. A timeout or completed cleanup is not a reproduction. This does not
isolate which of the corrected fixture defects matters; it tests the general
completed-work hypothesis with consistent prior evidence.

## Result and next experiment boundary

The product rule is that handoff must preserve the active authored instruction.
A generated summary can supply context, but must not replace that instruction.
`compactContextForHandoff` in `context-compaction.ts` currently wraps the summary
as the new current instruction and replaces history with it plus runtime context.
The component regression exposes this rule without another live model call.

Do not rerun this pair just to obtain silence. A further live experiment needs
an input that tests why the summary selects the old maintenance task rather than
the old coding task. A candidate hypothesis is that the original task provenance
and intervening history affect that selection. Test it with a sanitized replay
of the production input and the production model configuration before reducing
that input. Do not add arbitrary history to match its token count. Do not script
the summary or continuation in that live experiment.

No runtime fix is part of these experiments. The production failure remains
established by its trace; through pair 5, the reduced live reproduction remains
incomplete.

## Limits

This is a reduced coding task, not an exact replay. Prior maintenance text uses
bot-authored Slack history fixtures, not the original system-event provenance.
The model defaults differ from the original production model configuration.
The fixture has only prior edit and verification exchanges. These differences
remain possible causes if the small case does not fail.

CI currently runs the integration suite on changes to this folder. Each push
runs this pair once. Do not rerun the suite without reviewing the first result.
