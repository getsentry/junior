/**
 * Operator CLI for plugin service accounts.
 *
 * Connecting a service account gives everyone who can talk to Junior the
 * access that the plugin's service account policy allows, to what that
 * account can see. The dashboard Admin page is the main way to connect one.
 * This CLI is the out-of-band fallback. It runs against the deployment state
 * store, and Slack never sees the sign-in link or any token.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  disconnectServiceAccount,
  finishServiceAccountSignIn,
  getServiceAccountStatus,
  serviceAccountPlugins,
  startServiceAccountSignIn,
} from "@/chat/credentials/service-account";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type { PluginDefinition } from "@/chat/plugins/types";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { CLI_USAGE } from "./run";

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const CALLBACK_PATH = "/oauth/callback";

interface LoopbackCallback {
  close: () => void;
  redirectUrl: string;
  waitForCallback: () => Promise<URLSearchParams>;
}

/** Listen on a free loopback port for one OAuth redirect. */
async function listenForCallback(): Promise<LoopbackCallback> {
  let resolveCallback: (params: URLSearchParams) => void = () => {};
  const callback = new Promise<URLSearchParams>((resolve) => {
    resolveCallback = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        Connection: "close",
        "Content-Type": "text/plain; charset=utf-8",
        "Referrer-Policy": "no-referrer",
      })
      .end("Sign-in received. Return to your terminal.\n");
    resolveCallback(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    close: () => server.close(),
    redirectUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    waitForCallback: async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          callback,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Timed out waiting for the sign-in.")),
              SIGN_IN_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function requireServiceAccountPlugin(
  name: string,
): PluginDefinition | undefined {
  const plugin = pluginCatalogRuntime.getDefinition(name);
  if (plugin?.manifest.serviceAccount) {
    return plugin;
  }
  const supported = serviceAccountPlugins(
    pluginCatalogRuntime.getProviders(),
  ).map((candidate) => candidate.manifest.name);
  console.error(
    `Plugin "${name}" does not support a service account.` +
      (supported.length ? ` Supported plugins: ${supported.join(", ")}.` : ""),
  );
  return undefined;
}

async function runConnect(plugin: PluginDefinition): Promise<number> {
  const provider = plugin.manifest.name;
  const loopback = await listenForCallback();
  try {
    const { authorizationUrl } = await startServiceAccountSignIn({
      plugin,
      redirectUrl: loopback.redirectUrl,
    });
    console.log(
      [
        `Open this URL in a browser on this machine. Sign in as the account Junior should use for ${provider}, not as yourself:`,
        "",
        authorizationUrl.toString(),
        "",
        `Waiting for the redirect to ${loopback.redirectUrl} ...`,
      ].join("\n"),
    );
    const result = await finishServiceAccountSignIn({
      callback: await loopback.waitForCallback(),
      plugin,
    });
    if (!result.ok) {
      console.error(result.message);
      return 1;
    }
  } finally {
    loopback.close();
  }
  const tools = plugin.manifest.serviceAccount?.mcpTools ?? [];
  console.log(
    `Connected the ${provider} service account. Actors who have not connected ${provider} now use it for: ${tools.join(", ")}.`,
  );
  return 0;
}

async function runStatus(plugin: PluginDefinition): Promise<number> {
  const status = await getServiceAccountStatus(plugin);
  console.log(
    status.connectedAt
      ? `The ${status.provider} service account is connected since ${status.connectedAt}.`
      : `The ${status.provider} service account is not connected.`,
  );
  return 0;
}

async function runDisconnect(plugin: PluginDefinition): Promise<number> {
  const provider = plugin.manifest.name;
  await disconnectServiceAccount(plugin);
  console.log(
    `Removed the ${provider} service account from Junior. To revoke the grant, remove Junior's connection in the ${provider} account settings.`,
  );
  return 0;
}

/** Run `junior service-account connect|status|disconnect <plugin>`. */
export async function runServiceAccount(argv: string[]): Promise<number> {
  const [subcommand, name, ...rest] = argv;
  const run =
    subcommand === "connect"
      ? runConnect
      : subcommand === "status"
        ? runStatus
        : subcommand === "disconnect"
          ? runDisconnect
          : undefined;
  if (!run || !name?.trim() || rest.length > 0) {
    console.error(CLI_USAGE);
    return 1;
  }
  const plugin = requireServiceAccountPlugin(name.trim());
  if (!plugin) {
    return 1;
  }
  try {
    return await run(plugin);
  } finally {
    await disconnectStateAdapter();
  }
}
