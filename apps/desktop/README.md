# Junior desktop app

A Tauri v2 app that shows the Junior dashboard in a native window. It is also
the reference app for the Sentry Tauri SDK (`tauri-plugin-sentry` and
`tauri-plugin-sentry-api`).

Status: prototype.

## Run

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
for your OS, then:

```sh
pnpm install
JUNIOR_URL=https://junior.example.com pnpm --filter @sentry/junior-desktop dev
```

`pnpm --filter @sentry/junior-desktop check` bundles the webview SDK and runs
`cargo check`.

| Variable             | When       | Default                                          |
| -------------------- | ---------- | ------------------------------------------------ |
| `JUNIOR_URL`         | build, run | `http://localhost:3000`                          |
| `SENTRY_DSN`         | build      | none: Sentry is off                              |
| `SENTRY_ENVIRONMENT` | build      | `development` in debug builds, else `production` |

`JUNIOR_URL` must be the public dashboard URL (`JUNIOR_BASE_URL` on the
server), with the dashboard base path if there is one. A value at run time
wins over the value at build time.

## Sign-in

Google blocks its sign-in page in embedded webviews, so the app signs in
through the system browser:

1. The dashboard sends the webview to `auth/login`. The app cancels that
   navigation and opens `auth/desktop` in the system browser, with a
   loopback redirect URI and a PKCE challenge.
2. The browser signs in with Google as usual. Junior then redirects to the
   loopback port with a code that holds the browser session cookies,
   encrypted and valid for 60 seconds.
3. The app redeems the code at `auth/desktop/token` with the PKCE verifier,
   and sets the session cookies in its webview.

Server side: `packages/junior/src/chat/sign-in/desktop-handoff.ts` and
`packages/junior-dashboard/src/desktop-sign-in.ts`.

## Sentry

- `src-tauri/src/telemetry.rs`: Rust SDK with panics, native crash
  minidumps, release, environment, app sessions, and the
  `tauri-plugin-sentry` integration.
- `src/webview-sentry.ts`: browser SDK for every page of the main window,
  the remote dashboard included. `tauri-plugin-sentry-api` sends its events
  and breadcrumbs through the Rust SDK. `pnpm build:webview` bundles it, and
  `src-tauri/src/lib.rs` injects it.
- The app removes URL queries from breadcrumbs and events, and turns off
  console and click breadcrumbs, because these can hold conversation text.
- The desktop sign-in is a `desktop sign-in` transaction. Its token request
  continues the trace on the Junior server.

Source maps are not uploaded yet. Debug IDs, from `@sentry/vite-plugin` or
`sentry-cli sourcemaps inject`, make the Rust SDK forward webview events
unparsed
([getsentry/sentry-rust#1267](https://github.com/getsentry/sentry-rust/issues/1267)).
Those events then skip the Rust context and the URL scrubbing.
