/**
 * oEmbed providers from a vendored copy of oembed.com's `providers.json`.
 * `scripts/refresh-oembed-providers.mjs` refreshes the copy. Junior uses
 * only the plain oEmbed fields, never `html`.
 */
import * as z from "zod";
import providers from "./oembed-providers.json" with { type: "json" };

type Provider = { endpoint: string; patterns: RegExp[] };

let compiled: Provider[] | undefined;

// A scheme is a URL with `*` wildcards. An `http` scheme also matches the
// same URL on `https`, because most providers moved to `https`.
function schemePattern(scheme: string): RegExp {
  const pattern = scheme
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
    .replace(/^http:/, "https?:");
  return new RegExp(`^${pattern}$`, "i");
}

function readProviders(): Provider[] {
  compiled ??= providers.map((provider) => ({
    endpoint: provider.url.replace("{format}", "json"),
    patterns: provider.schemes.map(schemePattern),
  }));
  return compiled;
}

/** Return the oEmbed request URL for a page, or nothing for other hosts. */
export function oembedRequestUrl(url: URL): string | undefined {
  const provider = readProviders().find((candidate) =>
    candidate.patterns.some((pattern) => pattern.test(url.href)),
  );
  if (!provider || !URL.canParse(provider.endpoint)) return undefined;
  const request = new URL(provider.endpoint);
  request.searchParams.set("url", url.href);
  request.searchParams.set("format", "json");
  return request.href;
}

// A missing or bad field is left out, not a failed response.
const optionalText = z.string().trim().min(1).optional().catch(undefined);

// The plain oEmbed fields. `html` is not read, so it can never render.
const oembedResponseSchema = z.object({
  title: optionalText,
  author_name: optionalText,
  provider_name: optionalText,
  thumbnail_url: optionalText,
  cache_age: z.coerce.number().positive().optional().catch(undefined),
});

/** The plain fields of one oEmbed response. */
export type OembedResponse = z.output<typeof oembedResponseSchema>;

/** Read an oEmbed JSON body, or nothing when it is not one. */
export function parseOembedResponse(body: string): OembedResponse | undefined {
  try {
    const parsed = oembedResponseSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
