import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { StateAdapter } from "chat";
import type { ConversationPort } from "@sentry/junior-acp";
import type { User } from "@sentry/junior-plugin-api";

const ACP_PACKAGE_NAME = "@sentry/junior-acp";

export type AcpAuthorizationCompletion =
  | "busy"
  | "completed"
  | "conflict"
  | "expired"
  | "invalid";

interface AcpErrorContext {
  connectionId?: string;
  conversationId?: string;
  userId?: string;
}

export interface AcpPackage {
  completeAcpAuthorization(args: {
    state: StateAdapter;
    transactionId: string;
    user: User;
    userCode: string;
  }): Promise<AcpAuthorizationCompletion>;
  createAcpHttpHandler(options: {
    baseURL?: string;
    conversations: ConversationPort;
    onError?: (error: unknown, event: string, context: AcpErrorContext) => void;
    state: StateAdapter;
    version: string;
  }): (request: Request) => Promise<Response>;
}

/** Validate the ACP exports supplied by build-time app setup. */
export function acpPackageFromValue(value: unknown): AcpPackage | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { completeAcpAuthorization?: unknown })
      .completeAcpAuthorization !== "function" ||
    typeof (value as { createAcpHttpHandler?: unknown })
      .createAcpHttpHandler !== "function"
  ) {
    throw new Error(
      '@sentry/junior-acp must export "completeAcpAuthorization" and "createAcpHttpHandler" functions',
    );
  }
  return value as AcpPackage;
}

/** Load the ACP package from app setup or local package resolution. */
export async function loadAcpPackage(
  load?: () => Promise<unknown>,
): Promise<AcpPackage> {
  try {
    const mod = load
      ? await load()
      : await import(
          pathToFileURL(
            createRequire(`${process.cwd()}/package.json`).resolve(
              ACP_PACKAGE_NAME,
            ),
          ).href
        );
    const acpPackage = acpPackageFromValue(mod);
    if (!acpPackage) throw new Error("ACP package resolved with no exports");
    return acpPackage;
  } catch (error) {
    if (isMissingAcpPackage(error)) {
      throw new Error(
        'createApp({ experimental: { acp: true } }) requires installing "@sentry/junior-acp"',
        { cause: error },
      );
    }
    throw error;
  }
}

function isMissingAcpPackage(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  return (
    (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    error.message.includes(ACP_PACKAGE_NAME)
  );
}
