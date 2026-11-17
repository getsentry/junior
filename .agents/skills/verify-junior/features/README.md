# Junior verification map

This directory is the maintained source for verifying what Junior does. Read this index before you drive Junior. Then use the matching map file as the recipe. Design docs in `design/` state the intent and rules of a system; they name behaviors only by the claim IDs here.

## Baseline preconditions

- Start Junior with `node scripts/instance.mjs launch` (add `--mock` for the dashboard mock), and use the run directory that it prints as `$RUN_DIR`.
- Run `node scripts/instance.mjs doctor $RUN_DIR` and require every line to be `ok`.
- Never drive an instance that this run did not start. `instance.mjs launch` refuses when ports 3000 or 8969 are in use.
- Run `pnpm exec playwright install chromium` once per machine for `browse.mjs` and the e2e specs.

## Driving conventions

- Start every recipe from a new instance, unless its preconditions say otherwise. Mock state is process-local and changes as you drive.
- Run browser steps through `scripts/browse.mjs`. Prefer ARIA roles and accessible names, such as `role=button[name="Dismiss"]`.
- Run `test` and `eval` proofs through `scripts/proofs.mjs run`, or copy the exact command from the claim. Treat every command as literal.
- Run commands from the repo root.

## Proof and skip reporting

- Capture the action and the result: `browse.mjs` writes `steps.log`, an ARIA snapshot, a screenshot, and the tab title for each `--snap`.
- A `test` or `eval` proof is its log with the command, the claims, and the exit code (`proofs.mjs run` writes `<n>.log` and `summary.tsv`).
- Keep evidence in `$RUN_DIR/evidence/<map file>/`. It is outside the checkout, and `instance.mjs stop` keeps it.
- Record the claim ID (`<file>#<id>`) and the entry point with every artifact.
- Report a step that fails, with the command and the unmet precondition. Do not report a skipped entry point as verified through a different path.
- Mock dashboard data proves what the dashboard shows, not the server. Each claim that depends on a server rule also names a `test`.

## Claim IDs

- A claim ID is lowercase kebab-case and unique in its file. Cite it as `<file>#<id>`, where `<file>` is the file name without `.md`. Example: `automations#run-now`.
- Tests, evals, PRs, and design docs cite claims by this ID. When you add a test or eval case for a claim, put the ID in its name, so `rg 'automations#run-now'` finds the map entry and its proof.
- Do not rename or reuse an ID. When a behavior changes meaning, retire its ID and add a new one. Before you retire an ID, search the repo, `design/` included, for citations of it.

## Map entry contract

Each map file starts with an H1 title and one paragraph that describes the behavior. Then it has exactly five H2 sections, in this order.

1. `Claims` lists one bullet per claim: the ID, the behavior in user terms ("a user does X, the user sees Y"), and its proof. The proof is `drive`, `test` with the exact command, or `eval` with the exact command. A claim that spans two surfaces, such as the dashboard and Slack, names one proof for each.
2. `How to get to it` lists every user entry point. For a runtime invariant, it lists the triggers that start the work.
3. `Driving it with <harness>` starts with `Preconditions:`. Then each bullet starts with the claim IDs it proves, and pairs an action with an exact command and an observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.
5. `Gaps` lists each behavior with no runnable proof: its ID, what is missing, and what blocks a proof. Write `None.` when there are none.

Keep source structure out of the map. Name only entry points, stable handles, required state, commands, and observable proof. `node scripts/proofs.mjs check` fails when a command names a missing file or a title that no test has.

## Map files

- `automations.md`: Scheduled, Event, and channel-message Automations, their management, and the Automations dashboard.
- `github.md`: pull requests, issues, Watches, attribution, and GitHub cards.
- `review-desk.md`: Review items on the desk, in Slack cards, and above the message box.
- `background-work.md`: Turns and runs that survive host limits, lost wakes, and killed workers.
