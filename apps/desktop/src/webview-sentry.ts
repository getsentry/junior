// Sentry browser SDK for the desktop webview. The app injects this bundle
// into every page of the main window before page scripts run: the local
// sign-in pages and the remote dashboard (see `src-tauri/src/lib.rs`).
import {
  breadcrumbsIntegration,
  init,
  type BrowserOptions,
} from "@sentry/browser";
import { defaultOptions } from "tauri-plugin-sentry-api";

// The plugin options send events and breadcrumbs through the Rust SDK, which
// adds release, environment, and device context. They also replace the
// browser session with the app session.
const pluginIntegrations = defaultOptions.integrations as Extract<
  BrowserOptions["integrations"],
  (...args: never[]) => unknown
>;

init({
  ...defaultOptions,
  // Console and click breadcrumbs can hold conversation text from the
  // dashboard. Rust removes URL queries from the other breadcrumbs.
  integrations: (defaults) =>
    pluginIntegrations(
      defaults
        .filter((integration) => integration.name !== "Console")
        .map((integration) =>
          integration.name === "Breadcrumbs"
            ? breadcrumbsIntegration({ dom: false })
            : integration,
        ),
    ),
});
