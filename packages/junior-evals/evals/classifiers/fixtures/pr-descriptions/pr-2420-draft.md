Refs #2413.

Evidence comes from the 160 most recent `junior-behavioral` runs on evals.sentry.dev (Oct 14 – Oct 30). A short duration (2–10 s) is a replay of a recording. A long duration is a live run. Passes on unrelated PRs are mostly replays, so the counts below look at live runs.

## 1. Scheduling: "recurring slot … requester's afternoons are holds" — product fix

**Cause.** `STACK_TRACE_ERROR` is not a separate error. It is Vitest's 120 s test timeout (`makeTimeoutError` in `@vitest/runner` uses the `new Error("STACK_TRACE_ERROR")` stack). After the 60 s idle error, `close()` waits for the agent work that is still running, and the test reaches 120 s. So every error is the idle timeout.

The agent never passed this case live (0 of ~55 live runs). In every run after #2375, the agent calls `findMeetingTimes` with `attendees: [sam]` and no `optionalAttendees`. The tool adds the requester as required. The requester's DNS holds cover 12:00–17:00, so `slots: []`. The result does not say why. The agent then retries per day or per window (4–6 calls), or reads calendars, and times out or reports "no shared afternoon slot".

**Fix.** When no slot fits, `findMeetingTimes` returns `blockedBy`: the required attendees who are busy or outside their hours for the whole window. This is a fixed tool contract, so it has a unit test in `packages/junior-google/tests/calendar.test.ts`. No prompt or tool-description rule was added.

**Unverified.** Whether the model uses `blockedBy` to make the requester optional. CI is the first live run.

## 2. Delegation: "independent research tracks" — idle limit too short

**Cause.** The call waits for the research of three child agents and the parent's summary. Live runs that delegated took 45–126 s in total. Errors at 63–66 s had two child results back and one child or the summary still running, so one stretch alone was longer than 60 s. Recorded runs take 8–10 s. With `maxToolCallsPerTurn: 6`, children often fail with "Agent turn exceeded execution limit (6 tool calls)", and the parent then reads the docs itself. That makes the run longer.

A second, separate miss: in some live runs the parent does not delegate (`spawnAgent` 0 times, 7 direct calls). Those are real behavior misses, and I did not change them.

**Fix.** A new `idleTimeoutMs` call option in the fixture. This case uses 120 s idle and a 240 s test timeout, and the reason is beside the values. `policies/evals.md` and the evals README now name this exception, because the policy said to keep calls within 60 s.

**Unverified.** That 120 s covers the slowest live run. Whether the 6-call child limit should stay. It makes failed children likely, but it keeps runs bounded.

## 3. Scheduling: "requester corrects a one-sided answer" — no change

After #2375 merged, the agent puts the requester in `optionalAttendees` in this case and passes. There was 1 live error in ~25 runs, on #2371, which changed the system prompt itself. I found no remaining cause, so the case is unchanged. The `blockedBy` fix also helps when the agent forgets to make the requester optional.

## 4. Watches: "exact deployment before GitHub creates it" — cause found, fix needs a decision, no change

**Cause.** The case passes on every live run where the agent goes `searchTools` → `github_getDeployment` → `watchEvents`. It fails on every run where the agent calls `searchEventTypes` first (33 of 33). `searchEventTypes` returns the `deployment_source` identifier format. The agent then creates the correct watch directly, so the judge passes, and so do the identifier and events assertions. Only the `github_getDeployment` assertion fails. `github_getDeployment` is a deferred catalog tool, so the agent on that path never sees it, even though its description says "use it before waiting for a deployment outcome".

**Decision needed.** Either:

- (a) This is a product gap. The agent should read the current state before it waits, in case the deployment already finished. One fix is to let a resource type name its read tool and show it in `searchEventTypes`. That changes the plugin API, so I did not guess.
- (b) This is an eval bug. In this fixture the deployment does not exist, so the lookup has no visible effect, and the assertion checks the order of steps.

I left the case unchanged.

## Checks

- `pnpm --filter @sentry/junior-google test` (23 passed), `typecheck` for junior-google and junior-evals
- `pnpm --filter @sentry/junior-evals test` (harness, 9 files), `pnpm --filter @sentry/junior-google lint`, `file-length:check`, `test-architecture:check`, prettier on changed files
- I did not run evals locally (no ROACH_TOKEN or gateway). The `trigger-evals-behavioral` label starts the first real run.
