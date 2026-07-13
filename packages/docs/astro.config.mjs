import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sentryStarlightTheme, {
  monochromeCodeTheme,
} from "@sentry/starlight-theme";
import { sentryAgentMarkdown } from "@sentry/starlight-theme/agent-markdown";
export default defineConfig({
  site: "https://junior.sentry.dev",
  redirects: {
    "/get-started": "/start-here/quickstart",
    "/get-started/index": "/start-here/quickstart",
    "/get-started/quickstart": "/start-here/quickstart",
    "/start-here/deploy": "/start-here/deploy-to-vercel",
    "/deploy": "/start-here/deploy-to-vercel",
    "/deploy/vercel": "/start-here/deploy-to-vercel",
    "/extend/custom-plugins": "/extend/build-a-plugin",
    "/extend/plugins-overview": "/extend",
    "/extend/amplitude": "/extend/amplitude-plugin",
    "/extend/cloudflare": "/extend/cloudflare-plugin",
    "/extend/datadog": "/extend/datadog-plugin",
    "/extend/hex": "/extend/hex-plugin",
    "/plugins/overview": "/extend",
    "/plugins/agent-browser": "/extend/agent-browser-plugin",
    "/plugins/amplitude": "/extend/amplitude-plugin",
    "/plugins/cloudflare": "/extend/cloudflare-plugin",
    "/plugins/datadog": "/extend/datadog-plugin",
    "/plugins/github": "/extend/github-plugin",
    "/plugins/hex": "/extend/hex-plugin",
    "/plugins/linear": "/extend/linear-plugin",
    "/plugins/maintenance": "/extend/maintenance-plugin",
    "/plugins/notion": "/extend/notion-plugin",
    "/plugins/scheduler": "/extend/scheduler-plugin",
    "/plugins/sentry": "/extend/sentry-plugin",
    "/plugins/vercel": "/extend/vercel-plugin",
    "/extend/vercel": "/extend/vercel-plugin",
    "/operate/telemetry-runbooks": "/operate/reliability-runbooks",
    "/operate/security": "/operate/security-hardening",
    "/operate/reliability": "/operate/reliability-runbooks",
    "/operate/snapshots": "/operate/sandbox-snapshots",
    "/integrate/existing-app": "/start-here/existing-app",
  },
  integrations: [
    starlight({
      title: "Junior",
      description:
        "Production docs for Junior, the Slack bot runtime for Hono and Nitro apps.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/getsentry/junior",
        },
      ],
      sidebar: [
        {
          label: "Start Here",
          items: [
            { label: "Overview", link: "/start-here/overview/" },
            { label: "Using Junior", link: "/start-here/using-junior/" },
            { label: "Quickstart", link: "/start-here/quickstart/" },
            {
              label: "Slack App Setup",
              link: "/start-here/slack-app-setup/",
            },
            {
              label: "Deploy to Vercel",
              link: "/start-here/deploy-to-vercel/",
            },
            {
              label: "Existing App",
              link: "/start-here/existing-app/",
            },
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
            { label: "Build a Plugin", link: "/extend/build-a-plugin/" },
            {
              label: "Agent Browser Plugin",
              link: "/extend/agent-browser-plugin/",
            },
            {
              label: "Amplitude Plugin",
              link: "/extend/amplitude-plugin/",
            },
            {
              label: "Cloudflare Plugin",
              link: "/extend/cloudflare-plugin/",
            },
            { label: "Datadog Plugin", link: "/extend/datadog-plugin/" },
            { label: "GitHub Plugin", link: "/extend/github-plugin/" },
            { label: "Hex Plugin", link: "/extend/hex-plugin/" },
            { label: "Linear Plugin", link: "/extend/linear-plugin/" },
            {
              label: "Maintenance Plugin",
              link: "/extend/maintenance-plugin/",
            },
            { label: "Memory Plugin", link: "/extend/memory-plugin/" },
            { label: "Notion Plugin", link: "/extend/notion-plugin/" },
            { label: "Scheduler Plugin", link: "/extend/scheduler-plugin/" },
            { label: "Sentry Plugin", link: "/extend/sentry-plugin/" },
            { label: "Vercel Plugin", link: "/extend/vercel-plugin/" },
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
            { label: "Dashboard", link: "/operate/dashboard/" },
            {
              label: "Sandbox Snapshots",
              link: "/operate/sandbox-snapshots/",
            },
          ],
        },
        {
          label: "CLI",
          items: [
            { label: "junior init", link: "/cli/init/" },
            { label: "junior chat", link: "/cli/chat/" },
            { label: "junior check", link: "/cli/check/" },
            {
              label: "junior snapshot create",
              link: "/cli/snapshot-create/",
            },
            { label: "junior upgrade", link: "/cli/upgrade/" },
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
          ],
        },
        {
          label: "Contribute",
          items: [
            { label: "Development", link: "/contribute/development/" },
            { label: "Testing", link: "/contribute/testing/" },
            {
              label: "Local Agent Validation",
              link: "/contribute/local-agent-validation/",
            },
            {
              label: "Documentation Guidelines",
              link: "/contribute/documentation-guidelines/",
            },
            { label: "Releasing", link: "/contribute/releasing/" },
          ],
        },
      ],
      plugins: [
        sentryStarlightTheme(),
        sentryAgentMarkdown(),
      ],
    }),
  ],
  markdown: {
    shikiConfig: {
      theme: monochromeCodeTheme,
    },
  },
});
