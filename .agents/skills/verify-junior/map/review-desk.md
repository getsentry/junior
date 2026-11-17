# Review desk

The Review desk is where work waits for a person. Junior or a plugin adds a Review item: an action that asks a question, or a notice that only tells. Each assignee sees it on the desk and in its linked Slack threads, and the first answer lets the work continue. The dashboard labels the desk "Inbox". Intent and rules: `design/review-desk.md`.

## Claims

- `ask` Junior asks a person. The user sees the item on the desk, and one card in each linked Slack thread, with a button per choice, an Answer form, or only Dismiss for a notice. Proof: `drive` for the desk, and `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/slack/review-item-card-webhook.test.ts -t "posts one card in a thread that a linked child agent shares|lets only an assignee act on a private item card"` for the Slack card.
- `first-answer-closes` The first assignee answers or dismisses. The item closes for everyone, and every card shows that it is closed. Proof: `drive` for the desk, and `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/api/review-items/actions.test.ts tests/integration/slack/review-item-card-webhook.test.ts -t "closes an action item for every assignee on the first submit|closes an item everywhere on the first click in a Slack card"` for the other assignees and the Slack cards.
- `answer-resumes` A person answers. The agent gets the answer in its Conversation and continues the work. A dismiss starts no Turn. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/review-item-prompt-inputs.test.ts -t "gives each answer and typed message its own part, and a dismiss none"`, and `eval` with `pnpm --filter @sentry/junior-evals evals:behavioral evals/review-desk/items.eval.ts -t "when one Turn batches two answers"`.
- `thread-reply` An assignee replies in the Slack thread with an answer. The item closes. A reply that only acknowledges or asks back leaves it open. Proof: `eval` with `pnpm --filter @sentry/junior-evals evals:classifiers evals/classifiers/review-item-replies.eval.ts -t "when the reply picks an option, it answers the question|when the reply only acknowledges, it answers no question|when the reply asks a follow-up, it answers no question"`, and `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/slack/review-item-card-webhook.test.ts -t "keeps a question open when the person who replies may not answer it|delivers a question that a reply closed again when the reply is retried"`.
- `desk-groups` A user opens the Inbox. Open actions show under "Needs you" and notices under "FYI", oldest first. Closed items show only in search. Proof: `drive`, and `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/api/review-items/actions.test.ts -t "pages what waits on the viewer first with the waiting sort"` for the server order.
- `count` The Inbox badge and the browser tab show the number of open actions for the viewer as a named assignee. Proof: `drive`, and `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/api/review-items/actions.test.ts -t "counts each Inbox bundle across every page"` for the server count.
- `take` A user takes an item assigned to Everyone. The user becomes its only assignee. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/api/review-items/actions.test.ts -t "lets anyone take an item assigned to Everyone"`.
- `dedupe` A later run adds an item with the same key. The open item changes, and no second item shows. Proof: `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/review-item-tools.test.ts -t "updates one open item per dedupe key across Automation runs"`, and `eval` with `pnpm --filter @sentry/junior-evals evals:behavioral evals/review-desk/items.eval.ts -t "update it instead of adding another"`.
- `close-with-reason` The work resolves itself. Junior closes the item, and the desk shows who closed it and why. Proof: `drive` for the desk, `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/review-item-tools.test.ts -t "lets an agent close an item once, with a reason"`, and `eval` with `pnpm --filter @sentry/junior-evals evals:behavioral evals/review-desk/items.eval.ts -t "close its open item with a reason"`.
- `waiting` A dashboard conversation has an open item for the viewer. It shows under "Needs you", the question docks above the message box, and a typed message answers it. Proof: `drive`, and `test` with `pnpm --filter @sentry/junior exec vitest run tests/integration/api/review-items/actions.test.ts -t "lists each waiting conversation once, with its items newest first"` for the server list.

## How to get to it

- Slack: the item card in each linked thread, and a thread reply.
- Dashboard: `Inbox` in the `Primary` navigation (`/review`), the Home summary (`Needs you` card), "Needs you" in the conversation list, and the question above the message box.
- Settings: "Show Inbox count on the tab icon".
- MCP server: read-only search and fetch with the `review_items:read` scope.

## Driving it with browse.mjs

Preconditions:

- `instance.mjs launch --mock` started a new instance, and `instance.mjs doctor` passes. Mock items are process-local, so run the bullets in this order on a new instance.
- The mock has four open actions for `Dashboard User`, and one closed action, "Pick the canary region".
- `S=.agents/skills/verify-junior/scripts` and `E=$RUN_DIR/evidence/review-desk`.

- **`desk-groups`, `count`: open the Inbox.** Run `node $S/browse.mjs --out $E/desk --goto /review --order 'Pick the billing migration window|Choose the first migration batch|Handle the negative invoices|Approve the payments-v42 rollout' --absent 'role=navigation[name="Review items"] >> role=link[name=/^Pick the canary region/]' --title '(4) ' --expect 'role=link[name="Inbox 4"]' --snap inbox --fill 'role=searchbox[name="Search review items"]=canary' --expect 'role=list[name="Search results"] >> role=link[name=/^Pick the canary region Done/]' --snap search`. "Needs you" lists the four actions, oldest first. The closed item shows only in search. The tab title starts with `(4)`, and the Inbox link reads `Inbox 4`.
- **`desk-groups`: notices under FYI.** Run `node $S/browse.mjs --out $E/fyi --goto /review --expect 'role=region[name="FYI"]'`. See Gotchas.
- **`ask`, `first-answer-closes`: answer on the desk.** Run `node $S/browse.mjs --out $E/answer --goto '/review?item=qa-migration-window' --expect 'role=region[name="Answer"] >> role=button[name="Other…"]' --expect 'role=region[name="Answer"] >> role=button[name="Dismiss"]' --snap ask --click 'role=region[name="Answer"] >> role=button[name=/^Tuesday 14:00 UTC/]' --expect 'role=region[name="Outcome"] >> text=Dashboard User closed this' --goto /review --absent 'role=navigation[name="Review items"] >> role=link[name=/^Pick the billing migration window/]' --title '(3) ' --snap answered`. The form has one button per choice, `Other…`, and `Dismiss`. One click closes the item, and the count drops to 3.
- **`waiting`: answer with a typed message.** Run `node $S/browse.mjs --out $E/waiting --goto / --click 'role=navigation[name="Your conversations"] >> role=link[name="Waiting on you Roll out payments-v42 Aug 7"]' --expect 'role=region[name="Question: Approve the payments-v42 rollout"]' --snap docked --fill 'role=textbox[name="Continue this conversation"]=Hold until Monday, the EU team is out.' --press Enter --absent 'role=region[name="Question: Approve the payments-v42 rollout"]' --expect 'role=region[name="Asked Approve the payments-v42 rollout"] >> text=Answered by Dashboard User' --snap typed --goto /review --title '(2) ' --expect 'role=link[name="Inbox 2"]'`. The question docks above the message box. The typed message closes it.
- **`close-with-reason`: read the outcome.** Run `node $S/browse.mjs --out $E/closed --goto '/review?q=payments&item=qa-rollout' --expect 'role=region[name="Outcome"] >> text=Dashboard User closed this' --expect 'role=region[name="Outcome"] >> text=Replied in the conversation.' --snap outcome`. The Outcome region names who closed the item and why.

## Gotchas

- The mock replaces the Review items API with a process-local copy. A drive proves what the dashboard shows. The server rule of each claim has its own `test`.
- The mock has no notice and no item for Everyone. The FYI step fails with a timeout on the mock, and `take` cannot be driven.
- The mock version token never changes, so an open page does not refresh its count. Load the page again (`--goto`) before you check the count.
- The mock "reply" closes the oldest open item of the conversation. In production a model decides which question a reply answers (`thread-reply`).
- Do not use Slack-only claims (cards, thread replies) with `pnpm cli -- chat`. Local chat has no Slack cards.

## Gaps

- `desk-groups`: no drive, test, or e2e spec shows a notice under "FYI". The mock seeds no notice.
- `blocked-group` The Inbox lists blocked Automations under "Blocked automations". No e2e spec or drive covers it, and the mock seeds no blocked Automation item.
