# Live Slack QA

Use a ready `junior-example` Vercel Preview and a dedicated alias for the
`junior-staging` Slack app. Do not deploy test commits over the Production
build. Do not change `junior-prod`.

The `Slack QA alias` workflow selects or checks a preview. It does not create a
deployment, provision state, run Slack tests, or hold a lock. Infrastructure
setup and a signed-in Slack test user are still required.

## One-time setup

An operator with Vercel and Slack app access must complete these steps before
selecting a preview:

1. Enable Git previews for `junior-example` (`apps/example` in this repo).
   Only run trusted commits with QA credentials. Never give unreviewed fork
   code Slack, provider, or deployment credentials.
2. Configure Neon preview branches from a clean QA parent. Verify that each
   preview receives its own `DATABASE_URL` before its build starts. The existing
   build runs `junior upgrade`; this must only change the preview branch. Do not
   copy the shared database URL into Preview.
3. Give the preview separate Redis state. Do not share Redis with Production or
   another active preview. Use QA-only storage and secrets. Do not clone stored
   schedules, connected accounts, or production provider credentials.
4. Reserve a hostname such as `junior-slack-qa.sentry.dev`. Keep it outside
   automatic Production or Git branch domain assignment. The operator script
   accepts only `junior-slack-qa[-name].sentry.dev` hostnames. This is a proposal,
   not a claim that the hostname is provisioned.
5. Make `/api/webhooks/slack` reachable by Slack on this hostname while retaining
   Slack signature checks. Resolve Vercel deployment protection with the admin.
   Do not disable dashboard auth to make the webhook reachable. In particular,
   do not set `JUNIOR_PREVIEW_VERCEL_AUTH=true` on an unprotected preview.
6. Configure Events, Interactivity, and the staging slash command to use
   `https://<qa-alias>/api/webhooks/slack`. Use only the staging app's credentials
   in the selected preview. Set its `JUNIOR_BASE_URL` to the QA alias when the
   tested feature needs stable callback links.
7. Stop work that can post as the staging bot from the existing deployment and
   old previews. Moving the alias changes inbound routing only. It does not
   stop queued work or revoke bot credentials.
8. Provide an independent test user signed into the Slack browser. Use a test
   channel and fresh threads. Do not use the bot itself as the test user.

Create a GitHub environment named `slack-qa`. Limit deployment branches to
`main`, and configure:

- Secret `SLACK_QA_VERCEL_TOKEN`: a Vercel credential permitted to inspect the
  example project's deployments and assign its QA alias. Keep it out of preview
  code. Use the smallest available access scope.
- Variable `SLACK_QA_PROJECT_ID`: the `junior-example` project ID.
- Variable `SLACK_QA_TEAM_ID`: the owning Vercel team ID.
- Variable `SLACK_QA_ALIAS`: the dedicated QA hostname, without a scheme or path.

The workflow runs trusted `main` code, not the selected preview's code. It does
not change environment variables or deployment protection.

## Select and test

1. Push a trusted branch and wait for its Vercel Preview to be ready. Record the
   full commit SHA and exact deployment ID. Verify its isolated database and
   Redis configuration. Preview builds can run in parallel.
2. Coordinate with other testers in Slack. There is no reservation or lock.
3. Run `Slack QA alias` on `main` with action `select`, the deployment ID, and
   full commit SHA. It rejects a different project, repo, commit, non-ready
   deployment, or Production deployment. It assigns the alias and reads it back.
4. Record the workflow summary with the QA results. Run action `check` with the
   same ID and SHA before each test group and after the last group. A mismatch
   makes the run inconclusive. Stop testing; do not restore or delete the alias.
5. Test a mention, a follow-up reply, and an interactive control as the test
   user. Save Slack links or screenshots with the expected deployment and SHA.
   Check the observed replies, not only health or logs.
6. Stop the preview's work when done. Do not automatically restore or delete the
   alias: another tester may have selected a different preview. Coordinate
   cleanup of the preview and its state with the next tester.

Checks only show where the alias points when the request runs. They cannot
prove that it stayed unchanged between checks, prevent another tester from
moving it, or prove which build processed a delayed Slack event. If testers
collide, discard the affected results and repeat. This is an accepted limit of
this small, lock-free setup.

The same script can run in an operator shell with the four environment values:

```bash
node apps/example/scripts/slack-qa-alias.mjs select dpl_EXAMPLE <full-commit-sha>
node apps/example/scripts/slack-qa-alias.mjs check dpl_EXAMPLE <full-commit-sha>
```

Do not use `select` as a retry after an uncertain API response. Use `check`
first to see whether the assignment applied. A failed read is not permission
to overwrite another tester's selection.

## Scope

Vercel Preview does not run Vercel Cron. This first setup does not validate
scheduled automations or cron recovery. Queue delivery, preview protection,
provider callbacks, and Slack browser authentication need live verification.
Alias checks alone are not end-to-end QA.
