// Refresh the vendored oEmbed provider list from oembed.com.
// Run: node scripts/refresh-oembed-providers.mjs
// Junior keeps only the URL schemes and the endpoint of each provider.
import { writeFile } from "node:fs/promises";

const SOURCE = "https://oembed.com/providers.json";
const TARGET = "packages/junior/src/api/objects/web-page/oembed-providers.json";

// Junior fetches only `https`, so an `http` endpoint is asked on `https`.
function httpsEndpoint(url) {
  if (typeof url !== "string") return undefined;
  const endpoint = url.startsWith("http:") ? `https:${url.slice(5)}` : url;
  return endpoint.startsWith("https://") && URL.canParse(endpoint)
    ? endpoint
    : undefined;
}

// Junior matches a scheme with `URLPattern`, so drop a scheme it rejects.
function validScheme(scheme) {
  try {
    new URLPattern(scheme);
    return true;
  } catch {
    return false;
  }
}

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`${SOURCE} returned ${response.status}`);
const providers = await response.json();
const endpoints = providers
  .flatMap((provider) => provider.endpoints ?? [])
  .map((endpoint) => ({
    schemes: (Array.isArray(endpoint.schemes) ? endpoint.schemes : []).filter(
      validScheme,
    ),
    url: httpsEndpoint(endpoint.url),
  }))
  .filter((endpoint) => endpoint.url && endpoint.schemes.length > 0);
// One endpoint on each line keeps diffs of a refresh small.
await writeFile(
  TARGET,
  `[\n${endpoints.map((endpoint) => `  ${JSON.stringify(endpoint)}`).join(",\n")}\n]\n`,
);
console.log(
  `Wrote ${endpoints.length} endpoints of ${providers.length} providers to ${TARGET}.`,
);
