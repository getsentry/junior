# Junior for iOS

A native SwiftUI client for Junior. It matches the mobile layout of the
dashboard (the `classic` shell): Conversations, the Inbox, Automations, and the
navigation drawer, in dark and light themes. It uses only Junior's public API,
the MCP server at `/api/mcp`, and signs in with its OAuth flow.

## Layout

| Path                    | What it holds                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Packages/JuniorKit`    | Logic with no UI: the MCP client and OAuth, tool result models, Markdown, and display rules.                  |
| `Junior`                | The SwiftUI app. `Theme/` mirrors the dashboard tokens; each feature has its own folder.                       |
| `JuniorUITests`         | UI journeys against the mock MCP server.                                                                       |
| `project.yml`           | The XcodeGen project. `Junior.xcodeproj` is generated and not committed.                                       |
| `fastlane/`             | The signed TestFlight build that `.github/workflows/ios-beta.yml` runs.                                        |
| `scripts/`              | `mock-server.mjs`, `xcbuild.sh`, `sim.sh`, `device.sh`, `generate-icons.mjs`, and the CI steps in `.github/workflows/ios*.yml`. |

Each screen calls MCP tools (`searchConversations`, `getConversation`,
`sendMessage`, …); their result types mirror the tool schemas in
`packages/junior/src/api/mcp`. What MCP lacks (answering a Review item,
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
   apps/ios/scripts/sim.sh shots /tmp/junior-shots "home|/|dark" "inbox|/review|light"
   ```

   A shot is `name|dashboard path|theme`. The app opens the path like the web
   router does. `?drawer=1` opens the drawer and `?details=1` opens a
   Conversation's details. UI tests call `POST /__reset` on the mock server
   first, so writes from one test do not affect the next.

4. Run UI tests, one suite or test at a time:

   ```bash
   apps/ios/scripts/sim.sh ui-test NavigationUITests/testAnswerQuestion
   ```

To open the project in Xcode, run `xcodegen generate` in `apps/ios`.

### On an iPhone

Sign in to Xcode with your Apple ID (Xcode › Settings › Accounts), put
`DEVELOPMENT_TEAM = <team ID>` in `apps/ios/Local.xcconfig` (git ignores it),
connect the iPhone with Developer Mode on, and run `apps/ios/scripts/device.sh`.
A personal team also needs `JUNIOR_BUNDLE_ID = <a bundle ID of its own>` there,
and its builds expire after 7 days.

### Machine rules

One simulator can use about 10 GB of memory. `sim.sh` takes a machine lock,
waits until no other simulator is booted and the CPU is idle, builds before it
boots, and deletes the device that it created. To use a simulator that is
already booted, set `JUNIOR_IOS_REUSE_UDID`; the script installs the app there,
removes it at the end, and does not shut that simulator down.

`xcbuild.sh` shares one compilation cache per machine
(`~/Library/Caches/ios-agent-build.noindex`) and keeps DerivedData in this
checkout (`.build.noindex`). Checkout paths are remapped out of cache keys, so
a new worktree reuses compiled work.

## Launch arguments

| Argument          | Effect                                                        |
| ----------------- | ------------------------------------------------------------- |
| `-JuniorServer`   | Dashboard origin. The default is `http://127.0.0.1:4317`.     |
| `-JuniorOpen`     | A dashboard path to open, such as `/review?item=qa-rollout`.  |
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
no attachments, no spend, and no way to answer a Review item or change an
Automation; those open on the web.
