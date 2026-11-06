// The `web` recording rule of evals (`packages/junior-evals/roach.json`)
// matches this value. Change both together.
export const USER_AGENT = "junior-bot/0.1";
// Sites that serve Markdown send it instead of HTML. It is much smaller than
// the HTML page and needs no conversion. Other sites send HTML as before.
export const FETCH_ACCEPT = "text/markdown, text/html;q=0.9, */*;q=0.8";
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_REDIRECTS = 3;
export const DEFAULT_MAX_CHARS = 6000;
export const MAX_FETCH_CHARS = 12000;
export const MAX_FETCH_BYTES = 1_000_000;
