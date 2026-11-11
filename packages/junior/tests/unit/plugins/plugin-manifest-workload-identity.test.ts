import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@/chat/plugins/manifest";

const GCP = [
  "  gcp:",
  "    workload-identity-provider: projects/1/locations/global/workloadIdentityPools/vercel/providers/junior",
  "    service-account: app@example-project.iam.gserviceaccount.com",
  "    token: service-account-jwt",
  "    audience: https://app.example.com/*",
];
const AZURE = [
  "  azure:",
  "    tenant-id: 00000000-0000-0000-0000-000000000000",
  "    client-id: 11111111-1111-1111-1111-111111111111",
  "    scope: api://app/.default",
];

function manifest(lines: string[]): string {
  return [
    "name: example",
    "display-name: Example",
    "description: Example app",
    "env-vars:",
    "  EXAMPLE_API_KEY:",
    ...lines,
  ].join("\n");
}

function credentials(lines: string[]): string[] {
  return [
    "credentials:",
    "  type: workload-identity",
    "  domains:",
    "    - app.example.com",
    ...lines,
  ];
}

describe("workload identity manifest", () => {
  it.each([
    {
      name: "both gcp and azure",
      lines: credentials([...GCP, ...AZURE]),
      error: "Plugin example credentials must set exactly one of gcp or azure",
    },
    {
      name: "an unsupported issuer",
      lines: credentials([
        "  aws:",
        "    role-arn: arn:aws:iam::123456789012:role/junior",
      ]),
      error: 'Unrecognized key: "aws"',
    },
    {
      name: "an api header that sets the credential header",
      lines: [
        "domains:",
        "  - app.example.com",
        "api-headers:",
        '  authorization: "Key ${EXAMPLE_API_KEY}"',
        ...credentials(GCP),
      ],
      error:
        "Plugin example api-headers.authorization conflicts with credentials.header",
    },
    {
      name: "a service account JWT without an audience",
      lines: credentials(GCP.slice(0, -1)),
      error: "Plugin example credentials.gcp.audience",
    },
  ])("rejects $name", ({ lines, error }) => {
    expect(() => parsePluginManifest(manifest(lines), "/tmp/example")).toThrow(
      error,
    );
  });
});
