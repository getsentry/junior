// Refresh the vendored oEmbed provider list from oembed.com.
// Run: node scripts/refresh-oembed-providers.mjs
// Junior keeps only the URL schemes and the endpoint of each provider.
import { writeFile } from "node:fs/promises";

const SOURCE = "https://oembed.com/providers.json";
const TARGET = "packages/junior/src/api/objects/web-page/oembed-providers.json";

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`${SOURCE} returned ${response.status}`);
const providers = await response.json();
const endpoints = providers
  .flatMap((provider) => provider.endpoints ?? [])
  .filter(
    (endpoint) =>
      typeof endpoint.url === "string" &&
      /^https?:\/\//.test(endpoint.url) &&
      Array.isArray(endpoint.schemes) &&
      endpoint.schemes.length > 0,
  )
  .map((endpoint) => ({ schemes: endpoint.schemes, url: endpoint.url }));
// One endpoint on each line keeps diffs of a refresh small.
await writeFile(
  TARGET,
  `[\n${endpoints.map((endpoint) => `  ${JSON.stringify(endpoint)}`).join(",\n")}\n]\n`,
);
console.log(
  `Wrote ${endpoints.length} endpoints of ${providers.length} providers to ${TARGET}.`,
);
