---
name: slack-msw-tests
description: Author Slack HTTP integration tests using the repository MSW harness and fixture factories. Use when asked to add a Slack integration test, mock Slack API calls with MSW, test Slack action HTTP behavior, or assert Slack request payloads in tests.
---

Write new Slack HTTP integration tests in `tests/` using the shared MSW harness and Slack fixtures.

## Step 1: Classify the test

Use this skill only when the test validates outbound Slack HTTP behavior, including:

- Slack Web API method calls from `src/chat/slack-actions/*`
- Slack file upload HTTP flow (`files.getUploadURLExternal` + `files.slack.com/upload/*` + `files.completeUploadExternal`)
- Slack user lookup fetches in `src/chat/slack-user.ts`

If the target test is pure business logic with no Slack HTTP contract assertions, use a normal unit test and skip this skill.

## Step 2: Load only required references

| Need                           | Read                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| End-to-end authoring workflow  | `${CLAUDE_SKILL_ROOT}/references/test-authoring-playbook.md` |
| Endpoint and fixture mapping   | `${CLAUDE_SKILL_ROOT}/references/endpoint-fixture-matrix.md` |
| Existing bad patterns to avoid | `${CLAUDE_SKILL_ROOT}/references/anti-patterns-and-fixes.md` |

## Step 3: Author the test using project harness

1. Place tests under `tests/` with `*.test.ts` naming.
2. Import the real module under test (no Slack SDK module mock).
3. Queue Slack responses with helpers from `tests/msw/handlers/slack-api.ts`.
4. Use endpoint fixture builders from `tests/fixtures/slack/factories/api.ts`.
5. Execute the real function.
6. Assert both:
   - returned behavior/result
   - captured outbound Slack request payload(s)

Required Slack assistant-thread matrix when the change touches status/title/progress:

- Current inbound message has explicit `thread_ts`: assert `assistant.threads.*` uses that live thread context.
- Current inbound message omits `thread_ts`: assert status/title calls are skipped rather than synthesized from persisted state or generic message `ts`.
- If assistant lifecycle events are involved, verify they initialize assistant metadata without becoming an implicit substitute for the current message's `thread_ts`.

Do not create local MSW servers in test files. Global lifecycle is already configured via `tests/msw/setup.ts`.

## Step 4: Validate

Run:

- `pnpm test -- <target-test-files>`
- `pnpm typecheck`

Run this sanity check for forbidden patterns:

- `rg -n "vi\\.mock\\(\\s*['\"]@slack/web-api['\"]|vi\\.mock\\(\\s*['\"]@/chat/slack-actions/client['\"]" tests`

## Guardrails

- Do not use `vi.mock("@slack/web-api")` for Slack integration tests.
- Do not use `vi.mock("@/chat/slack-actions/client")` for Slack HTTP behavior tests.
- Do not stub `globalThis.fetch` for Slack hosts in these tests.
- Prefer fixture builders over ad hoc Slack JSON payload blobs.
- Keep IDs and timestamps deterministic by reusing factory defaults unless a test explicitly requires variation.
