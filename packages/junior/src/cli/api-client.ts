/** Resolve an API path under a Junior base URL and keep any base path. */
export function apiUrl(baseUrl: string, pathname: string): URL {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/*$/, "")}/`;
  base.search = "";
  base.hash = "";
  return new URL(pathname.replace(/^\//, ""), base);
}

/** Read one JSON response from the Junior API with a personal API token. */
export async function fetchJson(url: URL, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const body = (await response.text()).trim().slice(0, 500);
    throw new Error(
      `Dashboard request failed (${response.status} ${response.statusText})${body ? `: ${body}` : ""}`,
    );
  }
  return await response.json();
}
