/**
 * A short, hand-kept list of well-known oEmbed providers. Every other page
 * falls back to its Open Graph tags. Junior uses only the plain oEmbed
 * fields, never `html`. A provider that needs an access token, such as
 * Instagram, is not listed.
 */
import * as z from "zod";

type Provider = { endpoint: string; schemes: string[] };

const PROVIDERS: Provider[] = [
  {
    endpoint: "https://www.youtube.com/oembed",
    schemes: [
      "https://{*.}?youtube.com/watch*",
      "https://{*.}?youtube.com/shorts/*",
      "https://{*.}?youtube.com/live/*",
      "https://{*.}?youtube.com/playlist*",
      "https://youtu.be/*",
    ],
  },
  {
    endpoint: "https://vimeo.com/api/oembed.json",
    schemes: ["https://vimeo.com/*", "https://player.vimeo.com/video/*"],
  },
  {
    endpoint: "https://publish.x.com/oembed",
    schemes: ["https://{*.}?x.com/*/status/*"],
  },
  {
    endpoint: "https://publish.twitter.com/oembed",
    schemes: ["https://{*.}?twitter.com/*/status/*"],
  },
  {
    endpoint: "https://www.figma.com/api/oembed",
    schemes: ["https://www.figma.com/(file|design|board|slides|proto)/*"],
  },
  {
    endpoint: "https://www.loom.com/v1/oembed",
    schemes: ["https://{www.}?loom.com/(share|i)/*"],
  },
  {
    endpoint: "https://open.spotify.com/oembed",
    schemes: ["https://open.spotify.com/*", "https://spotify.link/*"],
  },
  {
    endpoint: "https://soundcloud.com/oembed",
    schemes: ["https://soundcloud.com/*", "https://on.soundcloud.com/*"],
  },
  {
    endpoint: "https://codepen.io/api/oembed",
    schemes: ["https://codepen.io/*/pen/*"],
  },
  {
    endpoint: "https://giphy.com/services/oembed",
    schemes: ["https://giphy.com/(gifs|clips)/*"],
  },
  {
    endpoint: "https://www.flickr.com/services/oembed/",
    schemes: ["https://{*.}?flickr.com/photos/*", "https://flic.kr/*"],
  },
  {
    endpoint: "https://www.tiktok.com/oembed",
    schemes: ["https://www.tiktok.com/*/video/*"],
  },
  {
    endpoint: "https://www.reddit.com/oembed",
    schemes: ["https://{www.}?reddit.com/r/*/comments/*"],
  },
  {
    endpoint: "https://www.slideshare.net/api/oembed/2",
    schemes: ["https://{*.}?slideshare.net/*/*"],
  },
  {
    endpoint: "https://speakerdeck.com/oembed.json",
    schemes: ["https://speakerdeck.com/*/*"],
  },
  {
    endpoint: "https://www.dailymotion.com/services/oembed",
    schemes: ["https://www.dailymotion.com/video/*", "https://dai.ly/*"],
  },
  {
    endpoint: "https://www.ted.com/services/v1/oembed.json",
    schemes: ["https://{www.}?ted.com/talks/*"],
  },
  {
    endpoint: "https://embed.bsky.app/oembed",
    schemes: ["https://bsky.app/profile/*/post/*"],
  },
];

const PATTERNS = PROVIDERS.map((provider) => ({
  endpoint: provider.endpoint,
  patterns: provider.schemes.map((scheme) => new URLPattern(scheme)),
}));

/** Return the oEmbed request URL for a page, or nothing for other hosts. */
export function oembedRequestUrl(url: URL): string | undefined {
  const provider = PATTERNS.find((candidate) =>
    candidate.patterns.some((pattern) => pattern.test(url.href)),
  );
  if (!provider) return undefined;
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
