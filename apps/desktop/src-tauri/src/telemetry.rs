//! Sentry setup for the whole app: Rust panics, native crashes (minidumps),
//! webview errors, and breadcrumbs from Rust, Tauri, and the webview.

use sentry::protocol::{Breadcrumb, Event, Value};
use sentry::ClientOptions;

/// Start Sentry. It sends nothing when the build had no `SENTRY_DSN`.
///
/// Call this first in `run`: with minidumps on, the crash reporter process
/// runs the same binary, and everything before `sentry::init` runs in both
/// processes.
pub fn init(plugin: &tauri_plugin_sentry::Sentry) -> sentry::ClientInitGuard {
    let environment = option_env!("SENTRY_ENVIRONMENT").unwrap_or(if cfg!(debug_assertions) {
        "development"
    } else {
        "production"
    });
    let mut options = ClientOptions::new()
        .maybe_release(sentry::release_name!())
        .environment(environment)
        // One person runs one app, so every sign-in trace is cheap to keep.
        .traces_sample_rate(1.0)
        // App sessions for release health. The webview setup turns off
        // browser sessions, so each app launch counts once.
        .auto_session_tracking(true)
        .before_breadcrumb(|mut breadcrumb| {
            scrub_breadcrumb(&mut breadcrumb);
            Some(breadcrumb)
        })
        .before_send(|mut event| {
            scrub_event(&mut event);
            Some(event)
        })
        // `Sentry` is both a Tauri plugin and a Sentry integration. The
        // integration adds app, OS, device, and webview context to every
        // event.
        .add_integration(plugin.clone());
    if let Some(dsn) = option_env!("SENTRY_DSN").filter(|dsn| !dsn.trim().is_empty()) {
        options = options.dsn(dsn.trim());
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    let options =
        options.add_integration(sentry::integrations::minidump::MinidumpIntegration::new());

    sentry::init(options)
}

// Dashboard URLs carry search text and ids in the query and fragment.
fn without_query(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or(url)
}

/// Remove URL queries from Rust, Tauri, and webview breadcrumbs. Navigation,
/// page-load, and fetch breadcrumbs keep their URL in `url`, `from`, or `to`.
fn scrub_breadcrumb(breadcrumb: &mut Breadcrumb) {
    for key in ["url", "from", "to"] {
        if let Some(Value::String(url)) = breadcrumb.data.get_mut(key) {
            *url = without_query(url).to_owned();
        }
    }
}

/// Remove the page query and cookies from webview events.
fn scrub_event(event: &mut Event<'static>) {
    if let Some(request) = event.request.as_mut() {
        if let Some(url) = request.url.as_mut() {
            url.set_query(None);
            url.set_fragment(None);
        }
        request.query_string = None;
        request.cookies = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breadcrumbs_lose_url_queries() {
        let mut breadcrumb = Breadcrumb::default();
        breadcrumb.data.insert(
            "url".into(),
            "https://junior.example.com/conversations?q=secret#top".into(),
        );
        breadcrumb
            .data
            .insert("to".into(), "/conversations/c1?view=tools".into());

        scrub_breadcrumb(&mut breadcrumb);

        assert_eq!(
            breadcrumb.data["url"],
            "https://junior.example.com/conversations"
        );
        assert_eq!(breadcrumb.data["to"], "/conversations/c1");
    }
}
