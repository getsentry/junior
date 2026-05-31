# Verification Map: `queue-and-locking`

| Capability          | Requirement                             | Scenario                                      | Primary Layer    | Current Coverage                                            | Action   | Gap                                                   | Notes                                      |
| ------------------- | --------------------------------------- | --------------------------------------------- | ---------------- | ----------------------------------------------------------- | -------- | ----------------------------------------------------- | ------------------------------------------ |
| `queue-and-locking` | Live thread queue configuration         | Production bot uses queue strategy            | unit/manual      | `production.ts`                                             | add      | Need composition test only if config drift is likely. | Avoid over-testing composition if brittle. |
| `queue-and-locking` | Live thread queue configuration         | Queue TTL exceeds max live turn               | unit/manual      | `production.ts` comment                                     | add      | Could assert config math in composition test.         | Exact 60s margin is implementation detail. |
| `queue-and-locking` | Live thread queue configuration         | Queue key uses normalized id                  | unit/integration | ingress normalization tests                                 | keep     | Owned mainly by `slack-ingress-routing`.              | Cross-link.                                |
| `queue-and-locking` | Queued and skipped message preservation | Skipped messages included next turn           | unit/integration | `slack-runtime.test.ts`, `new-mention-behavior.test.ts`     | keep     | None known                                            | Good behavior coverage.                    |
| `queue-and-locking` | Queued and skipped message preservation | Attachment fetchers rehydrated                | unit/integration | dispatcher/attachment tests                                 | keep/add | Add explicit dispatcher rehydration case if absent.   | Queue serialization edge.                  |
| `queue-and-locking` | Queued and skipped message preservation | Mention kind dispatches mention handler       | unit             | Existing coverage unclear                                   | add      | Add focused dispatcher test.                          | Pure.                                      |
| `queue-and-locking` | Queued and skipped message preservation | Subscribed kind dispatches subscribed handler | unit             | `queue/thread-message-dispatcher.test.ts`                   | keep     | None known                                            | Pure.                                      |
| `queue-and-locking` | State adapter key and lock prefixing    | Storage keys prefixed                         | unit             | `state/state-adapter-lock.test.ts`                          | keep     | None known                                            | Includes set/get.                          |
| `queue-and-locking` | State adapter key and lock prefixing    | Lock ids unprefixed                           | unit             | `state/state-adapter-lock.test.ts`                          | keep     | None known                                            | Good.                                      |
| `queue-and-locking` | State adapter key and lock prefixing    | Queue ids unprefixed                          | unit             | `state/state-adapter-lock.test.ts`                          | keep     | None known                                            | Good.                                      |
| `queue-and-locking` | Active lock heartbeat                   | SDK-sized lock heartbeats                     | unit             | `state/state-adapter-lock.test.ts`                          | keep     | None known                                            | Fake timers.                               |
| `queue-and-locking` | Active lock heartbeat                   | Release stops heartbeat                       | unit             | `state/state-adapter-lock.test.ts`                          | keep     | None known                                            | Good.                                      |
| `queue-and-locking` | Active lock heartbeat                   | Max age stops heartbeat                       | unit             | `state/state-adapter-lock.test.ts`                          | keep     | None known                                            | Good.                                      |
| `queue-and-locking` | Active lock heartbeat                   | Long TTL lock not heartbeated                 | unit             | `state/state-adapter-lock.test.ts`                          | keep     | None known                                            | Good.                                      |
| `queue-and-locking` | Resume lock coordination                | Resume acquires same lock                     | unit/integration | `handlers/turn-resume.test.ts`, `turn-resume-slack.test.ts` | keep     | None known                                            | Session spec owns deeper resume semantics. |
| `queue-and-locking` | Resume lock coordination                | Busy lock reports busy/retryable              | unit             | `handlers/turn-resume.test.ts`                              | keep     | None known                                            | Good.                                      |
| `queue-and-locking` | Resume lock coordination                | Lock released before deferred side effects    | unit             | Existing coverage unclear                                   | add      | Add if sequencing regressions are likely.             | Could be hard to assert cleanly.           |
| `queue-and-locking` | Active continuation follow-up handling  | Awaiting continuation rescheduled             | integration      | `slack/bot-handlers.test.ts`, `turn-resume-slack.test.ts`   | keep     | None known                                            | Cross-link session spec.                   |
| `queue-and-locking` | Active continuation follow-up handling  | No continuation proceeds normally             | integration      | `message-content-behavior.test.ts` active-turn case         | keep     | None known                                            | Good.                                      |
| `queue-and-locking` | Verification taxonomy                   | Adapter/dispatcher unit                       | manual           | This map                                                    | keep     | None                                                  | Taxonomy artifact.                         |
| `queue-and-locking` | Verification taxonomy                   | Runtime queue integration                     | manual           | This map                                                    | keep     | None                                                  | Taxonomy artifact.                         |
| `queue-and-locking` | Verification taxonomy                   | Resume callback ownership                     | manual           | This map                                                    | keep     | None                                                  | Session spec owns callback details.        |

## Layer Rules

- Use `unit` for state adapter lock/queue wrapper behavior, heartbeat timing, prefixing, dispatcher kind routing, and attachment fetcher rehydration.
- Use `integration` for Slack runtime skipped-message propagation, active continuation follow-up handling, resume lock interaction with persisted thread state, and queued-message prompt/context inclusion.
- Use `eval` only when model interpretation of queued/skipped context is the contract, and map those cases to `agent-turn-handling`.
- Use `manual` for composition and ownership decisions.

## Coverage Action Meanings

- `keep`: Current test/eval covers the scenario with the right scope and name.
- `rename`: Coverage is right, but taxonomy/name is misleading.
- `split`: File or case mixes multiple capabilities and should be separated.
- `move`: Coverage belongs in a different layer or package.
- `replace`: Existing coverage is low-fidelity or asserts the wrong contract.
- `delete`: Existing coverage duplicates another stronger check or asserts non-contract internals.
- `add`: No current coverage exists.
