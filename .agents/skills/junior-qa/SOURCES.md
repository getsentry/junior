# junior-qa Sources

## Repository Sources

| Source                                                                        | Trust | Contribution                                                                                                                                         |
| ----------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specs/local-agent.md`                                                        | High  | Canonical contract for local CLI behavior, fresh conversations, source/destination semantics, state adapter expectations, and verification guidance. |
| `packages/junior/tests/integration/local-agent-runner.test.ts`                | High  | Integration-level proof of local runner wiring and local source behavior.                                                                            |
| `packages/junior/tests/unit/cli/chat-cli.test.ts`                             | High  | CLI contract coverage for `chat -p` and interactive behavior.                                                                                        |
| `scripts/cli-with-root-env.mjs`                                               | High  | Confirms `pnpm cli` loads the repo app environment for local runs.                                                                                   |
| `packages/junior/src/cli/chat.ts`                                             | High  | Shows local CLI state adapter selection and why memory state is the default QA mode.                                                                 |
| `apps/example/app/SOUL.md`                                                    | High  | Example app soul loaded during local QA.                                                                                                             |
| `apps/example/app/WORLD.md`                                                   | High  | Example app world context loaded during local QA.                                                                                                    |
| `apps/example/app/skills/example-local/SKILL.md`                              | High  | Canonical top-level app skill probe.                                                                                                                 |
| `apps/example/app/plugins/example-bundle/plugin.yaml`                         | High  | Canonical local plugin fixture.                                                                                                                      |
| `apps/example/app/plugins/example-bundle/skills/example-bundle-help/SKILL.md` | High  | Canonical bundled plugin skill probe.                                                                                                                |
| `AGENTS.md`                                                                   | High  | Repository validation conventions, pnpm commands, and test/eval layer guidance.                                                                      |

## Verified Commands

These commands were run while authoring the skill:

```sh
pnpm cli -- chat -p "Say exactly: junior qa smoke ok"
```

Result: completed successfully and returned `junior qa smoke ok`.

```sh
pnpm cli -- chat -p "Say exactly: local memory default works"
```

Result after the default fix: completed successfully without setting `JUNIOR_STATE_ADAPTER=memory`, loaded the example app and bundled plugin, and returned `local memory default works`.

```sh
pnpm cli -- chat -p "/example-local confirm local QA discovery"
```

Result: completed successfully and followed the `example-local` skill.

```sh
pnpm cli -- chat -p "/example-bundle-help list local plugin QA signals"
```

Result before the default fix: local discovery succeeded, then the run hung with Redis DNS errors because `.env.local` provided `REDIS_URL`. This established that `REDIS_URL` alone must not change local chat away from memory state.

```sh
env JUNIOR_STATE_ADAPTER=memory pnpm cli -- chat -p "/example-bundle-help"
```

Historical pre-fix confirmation: completed successfully with host network access after forcing memory. This command remains evidence for the bundled skill behavior, but standard local QA should use the plain command now that memory is the default.

```sh
pnpm cli -- chat -p "/example-bundle-help"
```

Expected post-fix command: startup logs should load `SOUL.md`, `WORLD.md`, and `example-bundle`; discovery should find `example-bundle-help` and `example-local`; the final answer should explain the bundled skill source and lack of credential/provider auth support.

## Design Decisions

- Use an inline workflow skill instead of scripts because QA prompts need to vary with the changed behavior.
- Keep `apps/example` as the canonical fixture because the user stated it should generally be the local setup for testing.
- Keep memory as the default local chat state adapter so standard QA commands do not depend on Redis.
- Treat local CLI proof as platform-neutral smoke coverage, not as proof of Slack-specific contracts.

## Open Gaps

- No dedicated scripted assertion wrapper exists yet for parsing final answers out of noisy CLI logs.
- No local QA fixture currently proves every provider-specific app/plugin path; credentialed providers still need targeted integration tests or evals.
