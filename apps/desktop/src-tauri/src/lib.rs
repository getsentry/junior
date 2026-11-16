//! Junior desktop app: the Junior dashboard in a native window, with Sentry
//! for Rust, native crashes, and the webview through `tauri-plugin-sentry`.

mod sign_in;
mod telemetry;

use tauri::{
    ipc::CapabilityBuilder, webview::NewWindowResponse, AppHandle, Manager, Url, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_sentry::{JavaScriptOptions, Options, Sentry};

const MAIN_WINDOW: &str = "main";

/// Browser SDK setup from `src/webview-sentry.ts`. `pnpm build:webview`
/// bundles it with `@sentry/browser` and `tauri-plugin-sentry-api`.
const WEBVIEW_SENTRY: &str = include_str!("../../dist/webview-sentry.js");

/// The Junior deployment, with a trailing slash so relative joins keep a
/// dashboard base path. `JUNIOR_URL` at run time wins over the build value.
fn junior_url() -> Url {
    let value = std::env::var("JUNIOR_URL")
        .ok()
        .or_else(|| option_env!("JUNIOR_URL").map(String::from))
        .unwrap_or_else(|| "http://localhost:3000".into());
    let mut url = Url::parse(value.trim()).expect("JUNIOR_URL must be an absolute URL");
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    url
}

/// A page from `ui/`, served from the app origin.
fn local_page(path: &str) -> Url {
    let origin = if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    Url::parse(origin)
        .and_then(|origin| origin.join(path))
        .expect("local page URL is valid")
}

fn is_page(url: &Url, base: &Url, path: &str) -> bool {
    base.join(path)
        .is_ok_and(|page| url.origin() == page.origin() && url.path() == page.path())
}

/// Decide what one main-window navigation does. Returns false to cancel it.
fn route_navigation(app: &AppHandle, junior: &Url, url: &Url) -> bool {
    if is_page(url, junior, "auth/login") {
        let next = url
            .query_pairs()
            .find(|(key, _)| key == "next")
            .map(|(_, value)| value.into_owned());
        sign_in::start(app, next);
        return false;
    }
    if is_page(url, &local_page(""), "retry-sign-in") {
        sign_in::start(app, None);
        return false;
    }
    let external = matches!(url.scheme(), "http" | "https" | "mailto")
        && url.origin() != junior.origin()
        && url.origin() != local_page("").origin();
    if external {
        // Links to Slack, GitHub, and other sites open in the browser.
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
        return false;
    }
    true
}

fn open_main_window(app: &AppHandle, junior: &Url) -> tauri::Result<()> {
    // The dashboard page needs IPC to send webview events and breadcrumbs to
    // the Sentry plugin. It gets only the Sentry commands.
    app.add_capability(
        CapabilityBuilder::new("dashboard")
            .remote(format!("{}/*", junior.origin().ascii_serialization()))
            .local(false)
            .window(MAIN_WINDOW)
            .permission("sentry:default"),
    )?;

    let navigation = (app.clone(), junior.clone());
    let new_window = app.clone();
    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(junior.clone()))
        .title("Junior")
        .inner_size(1280.0, 860.0)
        .min_inner_size(720.0, 480.0)
        .initialization_script(WEBVIEW_SENTRY)
        .on_navigation(move |url| route_navigation(&navigation.0, &navigation.1, url))
        .on_new_window(move |url, _| {
            let _ = new_window.opener().open_url(url.as_str(), None::<&str>);
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

/// Start the app.
pub fn run() {
    // The app injects its own browser SDK setup, so the plugin injects none.
    let sentry_plugin = Sentry::with_options(Options {
        javascript: JavaScriptOptions::no_injection(),
        ..Default::default()
    });
    let _sentry = telemetry::init(&sentry_plugin);
    // Only the app process runs past this point; see `telemetry::init`.

    let junior = junior_url();
    let builder = tauri::Builder::default()
        .plugin(sentry_plugin)
        .plugin(tauri_plugin_opener::init())
        .manage(sign_in::SignIn::new(junior.clone()))
        .setup(move |app| {
            open_main_window(app.handle(), &junior)?;
            Ok(())
        });

    // WebKit on macOS reports webview process exits only through this
    // builder hook, which replaces the Tauri default reload.
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        tauri_plugin_sentry::web_content_process_terminated(webview);
        let _ = webview.reload();
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running Junior");
}
