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

## Rules

- Only domains that a plugin declares get credentials, and each domain has
  one owning plugin. Other traffic leaves the Sandbox unchanged.
- A request with no credential gets one only when its plugin says that its
  tools send none.
- A request from a browser, such as one that Playwright drives, never gets a
  credential, because page scripts are untrusted.
- The Sentry plugin does not let Sandbox code create releases or upload
  sourcemaps or debug files with the Actor's account.
- Junior never deletes a Sentry organization or project, whatever the
  credential or the Actor's role. A person does that in Sentry.
- Workspace setup scripts run with no provider credentials.
- Each Conversation's Sandbox can spend only a fixed share of the GitHub
  App's hourly GraphQL points. Sandbox GraphQL requests also stop when the
  App has only a reserve of points left, so that Junior's own GitHub calls
  keep working. Junior counts the points that GitHub charges, not an
  estimate. The denial says when the budget resets. A Conversation's
  Sandbox can also have only a few GraphQL requests in flight at one time.

## Gaps

- The GitHub plugin says that its tools send no credential, so any Sandbox
  request to GitHub that sends none gets one, also where GitHub uses the
  Actor's account. A repo script then acts as the Actor only because it
  calls GitHub. This breaks "Other code in the Sandbox does not act as the
  Actor only because it calls a provider domain".
