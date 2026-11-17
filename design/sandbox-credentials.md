# Sandbox credentials

Commands that Junior runs in a Sandbox, such as provider CLIs, git, and
scripts, reach provider APIs like GitHub and Sentry with no real token in the
Sandbox. When a request leaves the Sandbox, Junior adds the credential that
the plugin chooses: the plugin's own access, or the Actor's connected account.

## Intent

- Real credentials never enter the Sandbox or the model. The Sandbox holds
  only placeholders, because any code in it, such as a repo script or a page
  in the browser, is untrusted.
- A credential goes only on a request that asks for one. A tool asks by
  sending its plugin's placeholder. Other code in the Sandbox does not act
  as the Actor only because it calls a provider domain.
- A credential that a request carries itself is never replaced. A person
  can use another account in the Sandbox, such as a test login.
- Each credential is bound to one Actor, one Sandbox session, and an
  expiry. One person's credential never serves another person.
- Use the least access that does the job. Reads use the plugin's own access
  when it has one. The Actor's account is used only where the work needs
  that person.
- The plugin decides which requests get which access. A write that the
  plugin does not know is denied, not sent with the Actor's account.
- Credentials come from the installed plugins, not from loaded skills, so a
  CLI works in any Turn without a skill load first.
- A missing connection becomes a prompt to connect, not a silent failure.

## Entry points

- Sandbox commands: `bash`, git, provider CLIs such as `gh` and `sentry`,
  scripts, and the browser.
- Slack: the prompt to connect an account when a command needs it.
- Dashboard: Settings, Identities, to connect or disconnect an account. An
  Admin connects a Service account in the dashboard or with
  `junior service-account connect`.

## Rules

- Only domains that a plugin declares get credentials, and each domain has
  one owning plugin. Other traffic leaves the Sandbox unchanged.
- An env var such as `SENTRY_AUTH_TOKEN` holds a placeholder. Printing the
  env shows no secret.
- A request with no credential gets one only when its plugin says that its
  tools send none. Git is one such tool. Sentry tools always send the
  placeholder, so a Sentry request without it gets no credential.
- The Sentry plugin does not let Sandbox code create releases or upload
  sourcemaps or debug files with the Actor's account.
- Junior never deletes a Sentry organization or project, whatever the
  credential or the Actor's role. A person does that in Sentry.
- Workspace setup scripts run with no provider credentials.

## Gaps

- Every request to a plugin's domain gets a credential, whether or not it
  sends the placeholder, and no plugin can say that its tools send none.
  This breaks "a credential goes only on a request that asks for one" and
  "a request with no credential gets one only when its plugin says that its
  tools send none".
- Junior replaces a credential that the request carries itself, so another
  account, such as a browser login, does not work on a provider domain. This
  breaks "a credential that a request carries itself is never replaced".
- A Sentry write that the plugin does not know goes out with the Actor's
  account, including release, sourcemap, and debug file uploads. Only
  organization, project, and user deletion is denied. This breaks "a write
  that the plugin does not know is denied" and the rule on Sentry releases
  and uploads.
