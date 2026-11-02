import { getDashboardAgentName } from "../../agentName";
import { CopyButton } from "../../components/CopyButton";
import { Card } from "../../components/layout/Card";
import { useDocumentTitle } from "../../documentTitle";
import {
  dashboardContainerClass,
  dashboardInlineLinkClass,
} from "../../styles";

const MCP_DOCS_URL = "https://junior.sentry.dev/operate/mcp-server/";

/** Name the MCP server entry after the agent, for example `junior`. */
function mcpServerName(): string {
  return (
    getDashboardAgentName()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "junior"
  );
}

function ConfigBlock(props: { label: string; value: string }) {
  return (
    <div className="mt-5 first:mt-0">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-sm font-semibold">{props.label}</h2>
        <CopyButton getText={() => props.value} label={`Copy ${props.label}`} />
      </div>
      <pre className="mt-2 mb-0 overflow-x-auto rounded-md bg-dashboard-ink p-3 font-mono text-xs text-dashboard-text">
        {props.value}
      </pre>
    </div>
  );
}

/** Show the MCP server URL and client config for this deployment. */
export function McpSettingsPage() {
  useDocumentTitle("MCP");
  // The dashboard redirects to its canonical origin, which also serves MCP.
  const url = new URL("/api/mcp", window.location.origin).toString();
  const name = mcpServerName();
  const jsonConfig = JSON.stringify(
    { mcpServers: { [name]: { type: "http", url } } },
    null,
    2,
  );

  return (
    <div className={`${dashboardContainerClass} px-4 py-8 md:px-8`}>
      <section className="mx-auto w-full max-w-3xl">
        <h1 className="m-0 text-2xl font-bold">MCP</h1>
        <p className="mt-2 mb-0 max-w-2xl text-sm text-dashboard-text-muted">
          Connect Claude Code or another MCP client to list your{" "}
          {getDashboardAgentName()} conversations. The client signs in through
          this dashboard. Personal API tokens do not work here.
        </p>

        <Card className="mb-0 mt-6" padding="md" variant="raised">
          <ConfigBlock label="Server URL" value={url} />
          <ConfigBlock
            label="Claude Code"
            value={`claude mcp add --transport http ${name} ${url}`}
          />
          <ConfigBlock label="JSON config" value={jsonConfig} />
        </Card>

        <p className="mt-4 mb-0 text-sm text-dashboard-text-muted">
          The client must support OAuth with Client ID Metadata Documents.{" "}
          <a
            className={dashboardInlineLinkClass}
            href={MCP_DOCS_URL}
            rel="noreferrer"
            target="_blank"
          >
            Read the MCP server docs
          </a>
          .
        </p>
      </section>
    </div>
  );
}
