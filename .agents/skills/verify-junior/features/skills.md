# Skills

A user runs a skill by writing `$name` in a message. Junior tells the model which skills the message named, and the model loads each one with `loadSkill` in the same Turn. Junior injects no skill text on its own. A manual-only skill (`disable-model-invocation: true`, or `policy.allow_implicit_invocation: false` in a Codex `agents/openai.yaml`) is never used on its own. Junior uses it only when a person's message names it, or when a skill that Junior loaded in that Turn names it. Junior still accepts the older `/name` form. Plain words such as "use the <name> skill" do not unlock a manual-only skill. The Skills section of the System Plugins page lists every skill and marks manual-only skills "Manual only".

## Sub-features

- `dollar-invoke` A message with `$name` makes the model call `loadSkill` for that skill in that Turn, and the reply follows the skill.
- `two-skills` One message names two manual-only skills. The model loads both, and the one reply follows both.
- `manual-hidden` A request that matches a manual-only skill but does not name it does not use the skill.
- `chain-loadable` A manual-only skill that the named skill references as `$name` is loaded in the same Turn, and the reply has its result.
- `slash-legacy` `/name` at the start of a message or after a space runs the skill, the same as `$name`.
- `plain-words-no-unlock` "Use the <name> skill" without `$` does not run a manual-only skill.
- `manual-label` On the System Plugins page, the drawer of a manual-only skill says "Manual only", from frontmatter or from `agents/openai.yaml`. The drawer of a normal skill does not.
- `openai-yaml-manual` A skill that is manual-only through `agents/openai.yaml` behaves like `manual-hidden` when not named, and like `dollar-invoke` when named.

## How to get to it (user POV)

- Dashboard: the composer on `/` or in a Conversation. Write `$name` anywhere in the message.
- Slack: the same text in a message to Junior. This skill has no Slack harness.
- An Automation in skill mode runs one skill. That is `automations`, not this file.
- System, then `Plugins` (`/system/plugins`), `Skills` section: each skill is a `$name` chip that opens a drawer.

## Driving it with browse.mjs

Preconditions:

- Launch with the fixture skills: `RUN_DIR=$(SKILL_DIRS=$PWD/.agents/skills/verify-junior/fixtures/skills node $S/instance.mjs launch | tail -1)`, from the repo root. `launch` passes its environment to `pnpm dev`, and Junior reads skills from `SKILL_DIRS`. `instance.mjs doctor` passes.
- The fixtures in `fixtures/skills/` each hold a code that only the skill body has: `verify-skill-open` (`OPEN-3141`, normal), `verify-skill-alpha` (`ALPHA-7319`), `verify-skill-beta` (`BETA-4826`), `verify-skill-chain` (names `$verify-skill-chain-end`, which has `CHAIN-5150`), all manual-only in frontmatter, and `verify-skill-codex` (`CODEX-2604`), manual-only only through `agents/openai.yaml`.
- `E=$RUN_DIR/evidence/skills`, `N='role=textbox[name="Start a conversation"]'`, `R='article:has-text("junior-example")'`.
- A reply that has the code proves the skill body reached the model. A reply without it, plus no `loadSkill` call for that skill in the event log, proves it did not.

- **Labels (`manual-label`).** Run `node $S/browse.mjs --out $E/manual-label --goto /system --click 'role=link[name="Plugins"]' --expect 'role=button[name="$verify-skill-alpha"]' --click 'role=button[name="$verify-skill-alpha"]' --expect 'text=App or local skill · Manual only' --snap alpha --click 'role=button[name="Close $verify-skill-alpha"]' --click 'role=button[name="$verify-skill-codex"]' --expect 'text=App or local skill · Manual only' --snap codex --click 'role=button[name="Close $verify-skill-codex"]' --click 'role=button[name="$verify-skill-open"]' --expect 'text=OPEN-3141' --absent 'text=Manual only' --snap open`. The alpha and codex drawers say "Manual only". The open drawer does not.
- **Invoke (`dollar-invoke`).** Run `node $S/browse.mjs --out $E/dollar-invoke --timeout 300000 --goto / --fill "$N=\$verify-skill-alpha What is the code? Reply with only the code." --press Enter --idle --expect "$R >> text=ALPHA-7319" --snap reply --click 'role=button[name="Conversation menu"]' --click 'role=menuitem[name="Open event log"]' --expect 'text=loadSkill' --snap event-log`. The event log shows a `loadSkill` call for `verify-skill-alpha`.
- **Two skills (`two-skills`).** Run `node $S/browse.mjs --out $E/two-skills --timeout 300000 --goto / --fill "$N=Give me the \$verify-skill-alpha code and the \$verify-skill-beta code." --press Enter --idle --expect "$R >> text=ALPHA-7319" --expect "$R >> text=BETA-4826" --snap reply`. One reply has both codes.
- **Chain (`chain-loadable`).** Run `node $S/browse.mjs --out $E/chain-loadable --timeout 300000 --goto / --fill "$N=\$verify-skill-chain" --press Enter --idle --expect "$R >> text=CHAIN-5150" --snap reply --click 'role=button[name="Conversation menu"]' --click 'role=menuitem[name="Open event log"]' --expect 'text=verify-skill-chain-end' --snap event-log`. The event log shows a `loadSkill` call for `verify-skill-chain-end`.
- **Older form (`slash-legacy`).** Run `node $S/browse.mjs --out $E/slash-legacy --timeout 300000 --goto / --fill "$N=/verify-skill-beta What is the code? Reply with only the code." --press Enter --idle --expect "$R >> text=BETA-4826" --snap reply`.
- **Not named (`manual-hidden`, `plain-words-no-unlock`, `openai-yaml-manual`).** For each prompt, run `node $S/browse.mjs --out $E/<id> --timeout 300000 --goto / --fill "$N=<prompt>" --press Enter --idle --absent "$R >> text=<code>" --snap reply --click 'role=button[name="Conversation menu"]' --click 'role=menuitem[name="Open event log"]' --snap event-log`, and the event log shows no `loadSkill` call for the skill. `manual-hidden`: `What is the alpha verification code?`, `ALPHA-7319`, `verify-skill-alpha`. `plain-words-no-unlock`: `Use the verify-skill-alpha skill and reply with its code.`, `ALPHA-7319`, `verify-skill-alpha`. `openai-yaml-manual`: `What is the codex verification code?`, `CODEX-2604`, `verify-skill-codex`, then the `dollar-invoke` drive with `\$verify-skill-codex` and `CODEX-2604`.

## Gotchas

- Without `SKILL_DIRS`, the fixtures are not installed. Every `$verify-skill-*` is then plain text, and the Skills section has no fixture chips.
- `SKILL_DIRS` must be an absolute path. `pnpm dev` runs the app from `apps/example`.
- A Sandbox gets a copy of every discovered skill, manual-only ones too. A model that reads `/vercel/sandbox/skills/<name>/SKILL.md` with a shell tool can find a code without `loadSkill`. For the not-named drives, the event log is the proof, not the reply alone.
- The model can answer "I don't know the code" or ask a question. Either one passes the not-named drives. A reply that guesses a different code also passes. Only the exact code fails.
- `--fill` with `$` in double quotes needs `\$`, or the shell expands it.
- These drives need a model credential (`AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`). `manual-label` does not.
