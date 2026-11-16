//! Sign-in through the system browser.
//!
//! Google blocks its sign-in page in embedded webviews. When the dashboard
//! sends the webview to `auth/login`, the app cancels that navigation and
//! signs in through the system browser:
//!
//! 1. Listen on a random loopback port (RFC 8252).
//! 2. Open `auth/desktop` in the browser with the loopback redirect URI, a
//!    PKCE challenge (RFC 7636), and a random state.
//! 3. Junior signs the browser in with Google and redirects to the loopback
//!    port with a short-lived code.
//! 4. Redeem the code with the PKCE verifier, set the returned session
//!    cookies in the webview, and open the page that asked for sign-in.

use std::{
    collections::HashMap,
    fmt,
    net::Ipv4Addr,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use cookie::{time, SameSite};
use sentry::{protocol::SpanStatus, Breadcrumb, Level, TransactionContext};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{webview::Cookie, AppHandle, Manager, Url};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use crate::{local_page, MAIN_WINDOW};

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CALLBACK_PATH: &str = "/callback";
const CALLBACK_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Junior</title>\
    <p style=\"font-family:system-ui;text-align:center;margin-top:20vh\">\
    You are signed in. Close this tab and go back to Junior.</p>";

/// Sign-in state of the app. At most one browser sign-in runs at a time.
pub struct SignIn {
    junior: Url,
    running: AtomicBool,
}

impl SignIn {
    pub fn new(junior: Url) -> Self {
        Self {
            junior,
            running: AtomicBool::new(false),
        }
    }
}

#[derive(Debug)]
enum SignInError {
    /// The person did not finish sign-in in the browser.
    TimedOut,
    /// Junior refused the sign-in, for example an account outside the
    /// allowed domains.
    Refused,
    Failed(Box<dyn std::error::Error + Send + Sync>),
}

impl fmt::Display for SignInError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TimedOut => write!(f, "browser sign-in timed out"),
            Self::Refused => write!(f, "Junior refused the browser sign-in"),
            Self::Failed(error) => write!(f, "desktop sign-in failed: {error}"),
        }
    }
}

impl std::error::Error for SignInError {}

fn failed(error: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> SignInError {
    SignInError::Failed(error.into())
}

#[derive(Deserialize)]
struct TokenResponse {
    cookies: Vec<SessionCookie>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCookie {
    max_age_seconds: i64,
    name: String,
    secure: bool,
    value: String,
}

fn breadcrumb(message: &str, level: Level) {
    sentry::add_breadcrumb(Breadcrumb {
        category: Some("auth".into()),
        message: Some(message.into()),
        level,
        ..Default::default()
    });
}

/// Start a browser sign-in unless one is running. `next` is the dashboard
/// path to open after sign-in.
pub fn start(app: &AppHandle, next: Option<String>) {
    if app.state::<SignIn>().running.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<SignIn>();
        let result = sign_in(&app, &state.junior, next.as_deref()).await;
        state.running.store(false, Ordering::SeqCst);
        let Err(error) = result else { return };
        match &error {
            SignInError::TimedOut | SignInError::Refused => {
                breadcrumb(&error.to_string(), Level::Warning);
            }
            SignInError::Failed(_) => {
                sentry::capture_error(&error);
            }
        }
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.navigate(local_page("sign-in-failed.html"));
        }
    });
}

/// Run one browser sign-in in a `desktop sign-in` transaction.
async fn sign_in(app: &AppHandle, junior: &Url, next: Option<&str>) -> Result<(), SignInError> {
    let transaction =
        sentry::start_transaction(TransactionContext::new("desktop sign-in", "auth.sign_in"));
    let result = run_sign_in(app, junior, next, &transaction).await;
    transaction.set_status(match &result {
        Ok(()) => SpanStatus::Ok,
        Err(SignInError::TimedOut) => SpanStatus::DeadlineExceeded,
        Err(SignInError::Refused) => SpanStatus::PermissionDenied,
        Err(SignInError::Failed(_)) => SpanStatus::InternalError,
    });
    transaction.finish();
    result
}

async fn run_sign_in(
    app: &AppHandle,
    junior: &Url,
    next: Option<&str>,
    transaction: &sentry::Transaction,
) -> Result<(), SignInError> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| failed("main window is missing"))?;
    window.navigate(local_page("index.html")).map_err(failed)?;

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(failed)?;
    let port = listener.local_addr().map_err(failed)?.port();
    let verifier = random_token();
    let state = random_token();
    let mut start_url = junior.join("auth/desktop").map_err(failed)?;
    start_url
        .query_pairs_mut()
        .append_pair(
            "redirect_uri",
            &format!("http://127.0.0.1:{port}{CALLBACK_PATH}"),
        )
        .append_pair(
            "code_challenge",
            &URL_SAFE_NO_PAD.encode(Sha256::digest(&verifier)),
        )
        .append_pair("state", &state);
    app.opener()
        .open_url(start_url.as_str(), None::<&str>)
        .map_err(failed)?;
    breadcrumb("Opened browser sign-in", Level::Info);

    let span = transaction.start_child("auth.browser", "Wait for browser sign-in");
    let callback = tokio::time::timeout(SIGN_IN_TIMEOUT, receive_callback(&listener)).await;
    span.finish();
    let params = callback
        .map_err(|_| SignInError::TimedOut)?
        .map_err(failed)?;
    if params.get("state") != Some(&state) {
        return Err(failed("browser sign-in returned another state"));
    }
    if params.contains_key("error") {
        return Err(SignInError::Refused);
    }
    let code = params
        .get("code")
        .ok_or_else(|| failed("browser sign-in returned no code"))?;

    let token_url = junior.join("auth/desktop/token").map_err(failed)?;
    let span = transaction.start_child("http.client", "POST auth/desktop/token");
    // Trace headers join this request to the Junior server spans.
    let mut request = reqwest::Client::new()
        .post(token_url)
        .json(&serde_json::json!({ "code": code, "code_verifier": verifier }));
    for (name, value) in span.iter_headers() {
        request = request.header(name, value);
    }
    let response = request.send().await.and_then(|r| r.error_for_status());
    span.set_status(if response.is_ok() {
        SpanStatus::Ok
    } else {
        SpanStatus::InternalError
    });
    span.finish();
    let tokens: TokenResponse = response.map_err(failed)?.json().await.map_err(failed)?;

    let host = junior
        .host_str()
        .ok_or_else(|| failed("JUNIOR_URL has no host"))?;
    for session_cookie in tokens.cookies {
        window
            .set_cookie(webview_cookie(host, session_cookie))
            .map_err(failed)?;
    }
    breadcrumb("Signed in", Level::Info);

    // `next` comes from the dashboard login URL and is a path on Junior.
    let page = match next {
        Some(path) if path.starts_with('/') && !path.starts_with("//") => junior.join(path),
        _ => Ok(junior.clone()),
    };
    window.navigate(page.map_err(failed)?).map_err(failed)?;
    Ok(())
}

/// Accept loopback requests until the browser returns to the callback path,
/// and return its query parameters.
async fn receive_callback(listener: &TcpListener) -> std::io::Result<HashMap<String, String>> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buffer = vec![0; 8192];
        let read = stream.read(&mut buffer).await?;
        let request = String::from_utf8_lossy(&buffer[..read]);
        // Request line: `GET /callback?code=...&state=... HTTP/1.1`.
        let target = request.split_whitespace().nth(1).unwrap_or("/");
        let url = Url::parse("http://127.0.0.1")
            .and_then(|base| base.join(target))
            .ok()
            .filter(|url| url.path() == CALLBACK_PATH);
        let Some(url) = url else {
            stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await?;
            continue;
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
             Cache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{CALLBACK_PAGE}",
            CALLBACK_PAGE.len()
        );
        stream.write_all(response.as_bytes()).await?;
        return Ok(url.query_pairs().into_owned().collect());
    }
}

/// 32 random bytes as base64url: a valid PKCE verifier (RFC 7636 4.1).
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random source failed");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The Better Auth session cookie as the Junior server set it in the browser.
fn webview_cookie(host: &str, cookie: SessionCookie) -> Cookie<'static> {
    Cookie::build((cookie.name, cookie.value))
        .domain(host.to_owned())
        .path("/")
        .secure(cookie.secure)
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::seconds(cookie.max_age_seconds))
        .build()
}
