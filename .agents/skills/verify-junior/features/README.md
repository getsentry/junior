# Junior verification map

This directory is the maintained source for verifying the user-facing behavior of Junior. Read the index before you drive Junior, then use the matching feature file as the recipe. Design docs in `design/` state the goals and rules of a system, and name a behavior only by its sub-feature ID here.

## Baseline preconditions

- Start Junior with `node scripts/instance.mjs launch`, and use the run directory that it prints as `$RUN_DIR`. Add `--mock` only where a recipe says so.
- The run starts with an empty database and an empty Redis database. Nothing from another run or from your own `pnpm dev` shows.
- A model credential (`AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`) is set, so the dashboard composer runs real Turns.
- Run `node scripts/instance.mjs doctor $RUN_DIR` and require every line to be `ok`.
- Never drive an instance that this run did not start. `launch` refuses when port 3000 or 8969 is in use.
- Set `S=.agents/skills/verify-junior/scripts` and run commands from the repo root.

## Driving conventions

- Start each recipe in a new Conversation from the composer on `/`, unless its preconditions say otherwise. Conversations do not share state, so recipes in different Conversations can run at the same time.
- Run browser steps through `$S/browse.mjs`. Prefer ARIA roles and accessible names over CSS selectors or DOM position.
- Treat every command and prompt as literal. A different prompt is a different journey.
- Wait for a Turn with `--idle`, then check the result with `--expect`. Give drives that wait for a Turn `--timeout 300000`.
- Go back to a Conversation by the URL that `--snap` saved, not by its title. Junior renames it after the first reply.
- Do not clean up a mutation by hand. `instance.mjs stop` drops the run database. Do not remove proof artifacts.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is the `steps.log`, ARIA snapshot, screenshot, tab title, and URL that `browse.mjs` writes for each `--snap`.
- Mutation proof includes a second view: another page, a search, the Inbox count, or the event log of the Conversation.
- The agent's reply alone does not prove a side effect. Find the effect on the page that owns it.
- Keep evidence in `$RUN_DIR/evidence/<feature>/<sub-feature>/`. It is outside the checkout, and `instance.mjs stop` keeps it.
- Record the sub-feature ID (`<file>#<id>`) and the entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through a different path.
- The model is real, so a drive can take a different path. Report the path it took. Run a failed journey again once before you call it a failure, and report both runs.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run, and each prerequisite that this machine may not have.

A sub-feature ID is lowercase kebab-case and unique in its file. Cite it as `<file>#<id>`, for example `automations#run-now`. Do not rename or reuse an ID. Before you retire one, search the repo, `design/` included, for citations.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Composer](./composer.md) covers the message box under the transcript: sending, the queue (edit, delete, steer), `Stop`, drafts, files, quoting a reply, the `$` skill menu, and who sees the box.
- [Inbox](./inbox.md) covers asking a person, answering in the Inbox or in the composer, notices, taking, dedupe, and closing with a reason.
- [Guardian](./guardian.md) covers action review: ordinary work that runs, risky actions that ask or stop, the recorded decision, and the System card.
- [Background work](./background-work.md) covers one reply per message, a Turn that outlives its time limit, and a Turn whose worker is killed.
- [Automations](./automations.md) covers Scheduled, Event, and channel-message Automations from Slack, and the Automations pages.
- [GitHub](./github.md) covers pull requests, issues, Watches, attribution, and GitHub cards.
- [Sandbox credentials](./sandbox-credentials.md) covers which Sandbox requests get the Actor's credential, credentials that a request brings, browser requests, the connect prompt, and Sentry write denials.
- [Skills](./skills.md) covers `$name` invocation, several skills in one message, manual-only skills that stay hidden until named, chained skills, the older `/name` form, and the "Manual only" label.
