# Junior for iOS

A native SwiftUI client for Junior, laid out like the dashboard (the `classic`
shell): Conversations, the Inbox, Automations, and the drawer, in dark and light
themes. On a phone it has the mobile layout; on an iPad, each list shows beside
the open item. It uses only the MCP server at `/api/mcp` and its OAuth sign-in.

## Layout

| Path                    | What it holds                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Packages/JuniorKit`    | Logic with no UI: the MCP client and OAuth, tool result models, Markdown, display rules, and the demo.        |
| `Junior`                | The SwiftUI app. `Theme/` mirrors the dashboard tokens; each feature has its own folder.                       |
| `JuniorUITests`         | UI journeys against the mock MCP server.                                                                       |
| `project.yml`           | The XcodeGen project. `Junior.xcodeproj` is generated and not committed.                                       |
| `fastlane/`             | The signed TestFlight build that `.github/workflows/ios-beta.yml` runs.                                        |
| `scripts/`              | `mock-server.mjs`, `export-demo-data.mjs`, `xcbuild.sh`, `sim.sh`, `device.sh`, `generate-icons.mjs`, and the CI steps in `.github/workflows/ios*.yml`. |

Each screen calls MCP tools (`searchConversations`, `getConversation`,
`sendMessage`, …); their result types mirror the tool schemas in
`packages/junior/src/api/mcp`. What MCP lacks (answering an Inbox item,
changing an Automation, the event log) opens the dashboard in the in-app
browser.

## Run it

1. Build the dashboard once, then start the mock server. It serves a mock of
   the MCP server and its OAuth endpoints on `http://127.0.0.1:4317`, backed
   by the dashboard's mock data:

   ```bash
   pnpm --filter "@sentry/junior-dashboard..." run build
   node apps/ios/scripts/mock-server.mjs
   ```

2. Run the logic tests on macOS. They need no simulator:

   ```bash
   cd apps/ios/Packages/JuniorKit && swift test
   ```

3. Build the app, open screens on a simulator, and save screenshots:

   ```bash
   apps/ios/scripts/sim.sh shots /tmp/junior-shots "home|/|dark" "inbox|/inbox|light"
   ```

   A shot is `name|dashboard path|theme`. The app opens the path like the web
   router does. `?drawer=1` opens the drawer; `?details=1` and `?rename=1`
   open a Conversation's details and rename prompt, and `?q=` searches the
   Conversations list. UI tests call `POST /__reset` on the mock server
   first, so writes do not carry over.

4. Run UI tests, one suite or test at a time:

   ```bash
   apps/ios/scripts/sim.sh ui-test NavigationUITests/testAnswerQuestion
   ```

In `apps/ios`, `make init` installs the tools and `make xcode` makes and opens the Xcode project.

### On an iPhone

Run `make signing` in `apps/ios` with `MATCH_PASSWORD` set, connect the
iPhone with Developer Mode on, and run `apps/ios/scripts/device.sh`. The iPhone
must be in the match development profile. Without access to the match repo, sign
with your own team in `apps/ios/Local.xcconfig`, as `Signing.xcconfig` shows.

### Machine rules

One simulator can use about 10 GB of memory. `sim.sh` takes a machine lock,
waits until no other simulator is booted and the CPU is idle, builds before it
boots, and deletes the device that it created. To use a simulator that is
already booted, set `JUNIOR_IOS_REUSE_UDID`; the script installs the app there,
removes it at the end, and does not shut that simulator down.

## Logs

Logs use the subsystem `io.sentry.junior`. Message text shows only in a debugger.
Stream with `log stream --level debug --predicate 'subsystem == "io.sentry.junior"'`,
use Console.app with the iPhone connected, or use Settings › Copy logs.

## Launch arguments

| Argument          | Effect                                                        |
| ----------------- | ------------------------------------------------------------- |
| `-JuniorServer`   | Dashboard origin. The default is `http://127.0.0.1:4317`.     |
| `-JuniorOpen`     | A dashboard path to open, such as `/inbox?item=qa-rollout`.  |
| `-JuniorTheme`    | `dark`, `light`, or `system`.                                 |
| `-JuniorFixedNow` | An ISO time used as "now", for screenshots of the mock data.  |
| `-JuniorAccessToken` | Debug builds: start signed in with this token (the mock takes `mock-access-token`). |
| `-JuniorSignOut`  | Debug builds: start signed out.                               |

## Sign-in

Sign-in is Junior's MCP OAuth flow: authorization code with PKCE, Google
sign-in and the consent page in a browser sheet, and tokens in the Keychain
(an access token lasts an hour; refresh tokens rotate; a sign-in lasts 30
days). Junior registers no clients: the app's `client_id` is the URL of
`oauth-client.json` (a Client ID Metadata Document). Junior accepts only
`https` and loopback redirect URIs, so the app takes the redirect on
`http://127.0.0.1:<port>/callback`, as desktop MCP clients do.

`AppModel.oauthClientID` points at this branch's copy on GitHub; point it at a
stable published URL before release. Junior caches the document for 5 minutes.

## Design sources

- Colors and type come from `packages/junior-dashboard/src/tailwind.css`
  (`Theme/Tokens.swift`, `Theme/Typography.swift`). Inter and Outfit are
  bundled under the SIL Open Font License.
- Icons are the dashboard's own Lucide icons, Octicons, and Slack and GitHub
  marks. Regenerate `Theme/IconPaths.swift` with
  `node apps/ios/scripts/generate-icons.mjs` after you add an icon name.

## Not in the public API

MCP has user and assistant messages but no tool calls, so transcripts show no
activity rows. It has no read position (the app opens at the latest message),
no attachments, no spend, and no way to answer an Inbox item or change an
Automation; those open on the web.
