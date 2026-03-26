import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightTypedoc from "starlight-typedoc";

const juniorEntryPoints = [
  "../junior/src/handlers/router.ts",
  "../junior/src/handlers/webhooks.ts",
  "../junior/src/handlers/health.ts",
  "../junior/src/next-config.ts",
  "../junior/src/instrumentation.ts",
  "../junior/src/app/layout.tsx",
];

export default defineConfig({
  site: "https://junior.sentry.dev",
  redirects: {
    "/get-started": "/start-here/quickstart",
    "/get-started/index": "/start-here/quickstart",
    "/get-started/quickstart": "/start-here/quickstart",
    "/extend/custom-plugins": "/extend",
    "/extend/plugins-overview": "/extend",
    "/plugins/overview": "/extend",
    "/plugins/agent-browser": "/extend/agent-browser-plugin",
    "/plugins/github": "/extend/github-plugin",
    "/plugins/notion": "/extend/notion-plugin",
    "/plugins/sentry": "/extend/sentry-plugin",
    "/operate/telemetry-runbooks": "/operate/reliability-runbooks",
    "/operate/security": "/operate/security-hardening",
    "/operate/reliability": "/operate/reliability-runbooks",
    "/integrate/existing-app": "/start-here/quickstart",
  },
  integrations: [
    starlight({
      title: "Junior",
      description:
        "Production docs for Junior, the Slack bot runtime for Next.js apps.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/getsentry/junior",
        },
      ],
      components: {
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      sidebar: [
        {
          label: "Start Here",
          items: [
            { label: "Quickstart", link: "/start-here/quickstart/" },
            {
              label: "Verify & Troubleshoot",
              link: "/start-here/verify-and-troubleshoot/",
            },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Execution Model", link: "/concepts/execution-model/" },
            { label: "Thread Routing", link: "/concepts/thread-routing/" },
            {
              label: "Skills & Plugins",
              link: "/concepts/skills-and-plugins/",
            },
            {
              label: "Credentials & OAuth",
              link: "/concepts/credentials-and-oauth/",
            },
          ],
        },
        {
          label: "Extend",
          items: [
            { label: "Plugins", link: "/extend/" },
            {
              label: "Agent Browser Plugin",
              link: "/extend/agent-browser-plugin/",
            },
            { label: "GitHub Plugin", link: "/extend/github-plugin/" },
            { label: "Notion Plugin", link: "/extend/notion-plugin/" },
            { label: "Sentry Plugin", link: "/extend/sentry-plugin/" },
          ],
        },
        {
          label: "Operate",
          items: [
            { label: "Observability", link: "/operate/observability/" },
            {
              label: "Reliability Runbooks",
              link: "/operate/reliability-runbooks/",
            },
            {
              label: "Security Hardening",
              link: "/operate/security-hardening/",
            },
          ],
        },
        {
          label: "CLI",
          items: [
            { label: "junior init", link: "/cli/init/" },
            { label: "junior check", link: "/cli/check/" },
            {
              label: "junior snapshot create",
              link: "/cli/snapshot-create/",
            },
          ],
        },
        {
          label: "Reference",
          items: [
            {
              label: "Config & Environment",
              link: "/reference/config-and-env/",
            },
            {
              label: "Route & Handler Surface",
              link: "/reference/handler-surface/",
            },
            {
              label: "Plugin Auth & Context",
              link: "/reference/runtime-commands/",
            },
            { label: "API Reference Guide", link: "/reference/api/" },
          ],
        },
        {
          label: "Contribute",
          items: [
            { label: "Development", link: "/contribute/development/" },
            { label: "Testing", link: "/contribute/testing/" },
            { label: "Releasing", link: "/contribute/releasing/" },
          ],
        },
      ],
      plugins: [
        starlightTypedoc({
          entryPoints: juniorEntryPoints,
          tsconfig: "../junior/tsconfig.build.json",
          output: "reference/api",
          sidebar: {
            label: "API Reference",
          },
          typeDoc: {
            excludePrivate: true,
            excludeProtected: true,
            hideBreadcrumbs: true,
            readme: "none",
            gitRevision: "main",
          },
        }),
      ],
    }),
  ],
});
