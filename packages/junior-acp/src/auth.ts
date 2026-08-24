import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { userSchema, type User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  fenceLock,
  MUTATION_LOCK_TTL_MS,
  withLock,
  type AcpState,
} from "./state";
import {
  ACP_STATE_TTL_MS,
  bindAcpConnectionUser,
  completeAcpRequest,
  type AcpRequestReceipt,
} from "./transport";

const ACP_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const ACP_CONNECTION_COOKIE = "junior_acp_connection";
const LOCK_WAIT_MS = 5_000;
const jsonRpcIdSchema = z.union([z.string(), z.number().finite(), z.null()]);

const acpAuthorizationSchema = z
  .object({
    connectionId: z.string().uuid(),
    credentialHash: z.string().length(64),
    elicitationId: z.string().uuid(),
    expiresAtMs: z.number().int().positive(),
    requestId: jsonRpcIdSchema,
    requestKey: z.string().min(1),
    userCodeHash: z.string().length(64),
  })
  .strict();

const acpAuthorizationPointerSchema = z
  .object({
    expiresAtMs: z.number().int().positive(),
    transactionId: z.string().uuid(),
  })
  .strict();

type AcpAuthorization = z.output<typeof acpAuthorizationSchema>;

export type AcpAuthorizationCompletion =
  | "busy"
  | "completed"
  | "conflict"
  | "expired"
  | "invalid";

export const ACP_AUTH_METHOD_ID = "junior";

export const ACP_AUTH_METHOD = {
  id: ACP_AUTH_METHOD_ID,
  name: "Sign in to Junior",
  description: "Sign in with the Google account allowed by this Junior app.",
} satisfies acp.AuthMethod;

function authorizationKey(transactionId: string): string {
  return `junior:acp:v1:authorization:${transactionId}`;
}

function authorizationLockKey(transactionId: string): string {
  return `${authorizationKey(transactionId)}:lock`;
}

function authorizationPointerKey(connectionId: string): string {
  return `junior:acp:v1:connection:${connectionId}:authorization`;
}

function authorizationPointerLockKey(connectionId: string): string {
  return `${authorizationPointerKey(connectionId)}:lock`;
}

function credentialHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createUserCode(): string {
  const value = randomBytes(6).toString("hex").toUpperCase();
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
}

function userCodeHash(value: string): string {
  return credentialHash(value.trim().replaceAll("-", "").toUpperCase());
}

function userCodeMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(userCodeHash(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cookieValue(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== ACP_CONNECTION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    if (value) return value;
  }
  return undefined;
}

function cookieAttributes(request: Request): string {
  return [
    "Path=/api/acp",
    "HttpOnly",
    "SameSite=Strict",
    ...(new URL(request.url).protocol === "https:" ? ["Secure"] : []),
  ].join("; ");
}

/** Create the secret cookie that proves control of one ACP connection. */
export function createAcpConnectionCredential(request: Request): {
  cookie: string;
  credentialHash: string;
} {
  const credential = randomBytes(32).toString("base64url");
  return {
    cookie: `${ACP_CONNECTION_COOKIE}=${credential}; ${cookieAttributes(request)}; Max-Age=86400`,
    credentialHash: credentialHash(credential),
  };
}

/** Verify that this request controls the supplied ACP connection hash. */
export function hasAcpConnectionCredential(
  request: Request,
  expectedHash: string,
): boolean {
  const credential = cookieValue(request);
  if (!credential) return false;
  const actual = Buffer.from(credentialHash(credential), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function authorizationBaseURL(request: Request, configured?: string): URL {
  const value = configured?.trim();
  let origin = value || new URL(request.url).origin;
  if (value && !/^https?:\/\//.test(value)) origin = `https://${value}`;
  const url = new URL(origin);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function readAuthorization(
  state: AcpState,
  transactionId: string,
): Promise<AcpAuthorization | undefined> {
  const value = await state.get(authorizationKey(transactionId));
  return value === null || value === undefined
    ? undefined
    : acpAuthorizationSchema.parse(value);
}

async function readAuthorizationPointer(
  state: AcpState,
  connectionId: string,
): Promise<z.output<typeof acpAuthorizationPointerSchema> | undefined> {
  const value = await state.get(authorizationPointerKey(connectionId));
  return value === null || value === undefined
    ? undefined
    : acpAuthorizationPointerSchema.parse(value);
}

async function deleteAuthorizationPointer(
  state: AcpState,
  connectionId: string,
  transactionId: string,
): Promise<void> {
  const result = await withLock(
    state,
    authorizationPointerLockKey(connectionId),
    async (lock) => {
      const pointer = await readAuthorizationPointer(state, connectionId);
      if (pointer?.transactionId !== transactionId) return;
      await fenceLock(state, lock, MUTATION_LOCK_TTL_MS);
      await state.delete(authorizationPointerKey(connectionId));
    },
    {
      keepAlive: true,
      ttlMs: MUTATION_LOCK_TTL_MS,
      waitMs: LOCK_WAIT_MS,
    },
  );
  if (!result.acquired) {
    throw new Error("Timed out acquiring ACP authorization pointer control");
  }
}

/** Remove one completed transaction and its matching connection pointer. */
async function deleteAuthorization(
  state: AcpState,
  authorization: AcpAuthorization,
  transactionId: string,
): Promise<void> {
  await deleteAuthorizationPointer(
    state,
    authorization.connectionId,
    transactionId,
  );
  await state.delete(authorizationKey(transactionId));
}

function completionReceipt(
  authorization: AcpAuthorization,
  response: acp.AnyResponse,
): AcpRequestReceipt {
  return {
    deliveryKey: `${authorization.requestKey}:authorization-complete`,
    outputs: [
      {
        kind: "message",
        message: {
          jsonrpc: "2.0",
          method: acp.methods.client.elicitation.complete,
          params: { elicitationId: authorization.elicitationId },
        },
      },
      { kind: "message", message: response },
    ],
  };
}

function resultMessage(requestId: acp.JsonRpcId): acp.AnyResponse {
  return { jsonrpc: "2.0", id: requestId, result: {} };
}

function cancelledMessage(
  requestId: acp.JsonRpcId,
  message = "Junior sign-in was cancelled",
): acp.AnyResponse {
  return {
    jsonrpc: "2.0",
    id: requestId,
    error: acp.RequestError.requestCancelled(
      undefined,
      message,
    ).toErrorResponse(),
  };
}

/** Start browser authorization for one ACP authenticate request. */
export async function beginAcpAuthorization(args: {
  baseURL?: string;
  connectionId: string;
  credentialHash: string;
  request: Request;
  requestId: acp.JsonRpcId;
  requestKey: string;
  state: AcpState;
}): Promise<AcpRequestReceipt> {
  const result = await withLock(
    args.state,
    authorizationPointerLockKey(args.connectionId),
    async (lock) => {
      const pointer = await readAuthorizationPointer(
        args.state,
        args.connectionId,
      );
      if (pointer) {
        const pending = await readAuthorization(
          args.state,
          pointer.transactionId,
        );
        if (pending?.connectionId === args.connectionId) {
          throw acp.RequestError.invalidRequest(
            undefined,
            "Junior sign-in is already in progress",
          );
        }
        await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
        await args.state.delete(authorizationPointerKey(args.connectionId));
      }

      const transactionId = randomUUID();
      const userCode = createUserCode();
      const authorization = acpAuthorizationSchema.parse({
        connectionId: args.connectionId,
        credentialHash: args.credentialHash,
        elicitationId: transactionId,
        expiresAtMs: Date.now() + ACP_AUTHORIZATION_TTL_MS,
        requestId: args.requestId,
        requestKey: args.requestKey,
        userCodeHash: userCodeHash(userCode),
      });
      await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
      await args.state.set(
        authorizationKey(transactionId),
        authorization,
        ACP_STATE_TTL_MS,
      );
      await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
      await args.state.set(
        authorizationPointerKey(args.connectionId),
        { expiresAtMs: authorization.expiresAtMs, transactionId },
        ACP_STATE_TTL_MS,
      );
      return { transactionId, userCode };
    },
    {
      keepAlive: true,
      ttlMs: MUTATION_LOCK_TTL_MS,
      waitMs: LOCK_WAIT_MS,
    },
  );
  if (!result.acquired) {
    throw new Error("Timed out acquiring ACP authorization pointer control");
  }
  const { transactionId, userCode } = result.value;
  const url = authorizationBaseURL(args.request, args.baseURL);
  url.pathname = `/_junior/acp/auth/${transactionId}`;
  const params = {
    mode: "url",
    message: `Sign in to Junior in your browser. Enter verification code ${userCode}.`,
    elicitationId: transactionId,
    requestId: args.requestId,
    url: url.toString(),
  } satisfies acp.CreateElicitationRequest;
  return {
    deliveryKey: `${args.requestKey}:authorization-start`,
    outputs: [
      {
        kind: "message",
        message: {
          jsonrpc: "2.0",
          id: transactionId,
          method: acp.methods.client.elicitation.create,
          params,
        },
      },
    ],
  };
}

async function finishAuthorization(args: {
  authorization: AcpAuthorization;
  response: acp.AnyResponse;
  state: AcpState;
}): Promise<"busy" | "completed" | "expired"> {
  const result = await completeAcpRequest({
    connectionId: args.authorization.connectionId,
    receipt: completionReceipt(args.authorization, args.response),
    requestKey: args.authorization.requestKey,
    state: args.state,
  });
  return result === "full" ? "busy" : result;
}

/** Bind a Google-authenticated user and resume the pending ACP request. */
export async function completeAcpAuthorization(args: {
  state: AcpState;
  transactionId: string;
  user: User;
  userCode: string;
}): Promise<AcpAuthorizationCompletion> {
  const result = await withLock(
    args.state,
    authorizationLockKey(args.transactionId),
    async (lock) => {
      const authorization = await readAuthorization(
        args.state,
        args.transactionId,
      );
      if (!authorization) {
        return "expired" as const;
      }
      if (authorization.expiresAtMs <= Date.now()) {
        const completion = await finishAuthorization({
          authorization,
          response: cancelledMessage(
            authorization.requestId,
            "Junior sign-in request expired",
          ),
          state: args.state,
        });
        if (completion === "busy") return completion;
        await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
        await deleteAuthorization(
          args.state,
          authorization,
          args.transactionId,
        );
        return "expired" as const;
      }
      if (!userCodeMatches(args.userCode, authorization.userCodeHash)) {
        return "invalid" as const;
      }
      const binding = await bindAcpConnectionUser({
        connectionId: authorization.connectionId,
        credentialHash: authorization.credentialHash,
        state: args.state,
        user: userSchema.parse(args.user),
      });
      if (binding !== "completed") {
        const completion = await finishAuthorization({
          authorization,
          response: cancelledMessage(
            authorization.requestId,
            "Junior sign-in could not bind this connection",
          ),
          state: args.state,
        });
        if (completion !== "completed") return completion;
        await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
        await deleteAuthorization(
          args.state,
          authorization,
          args.transactionId,
        );
        return binding;
      }
      const completion = await finishAuthorization({
        authorization,
        response: resultMessage(authorization.requestId),
        state: args.state,
      });
      if (completion !== "completed") return completion;
      await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
      await deleteAuthorization(args.state, authorization, args.transactionId);
      return "completed" as const;
    },
    {
      keepAlive: true,
      ttlMs: MUTATION_LOCK_TTL_MS,
      waitMs: LOCK_WAIT_MS,
    },
  );
  if (!result.acquired) {
    throw new Error("Timed out acquiring ACP authorization control");
  }
  return result.value;
}

/** Consume a client response to the browser URL elicitation. */
export async function handleAcpAuthorizationResponse(args: {
  connectionId: string;
  response: acp.AnyResponse;
  state: AcpState;
}): Promise<"accepted" | "cancelled" | "ignored"> {
  if (typeof args.response.id !== "string") return "ignored";
  const parsedId = z.string().uuid().safeParse(args.response.id);
  if (!parsedId.success) return "ignored";
  const authorization = await readAuthorization(args.state, parsedId.data);
  if (!authorization || authorization.connectionId !== args.connectionId) {
    return "ignored";
  }
  const action =
    "result" in args.response &&
    typeof args.response.result === "object" &&
    args.response.result !== null &&
    "action" in args.response.result &&
    typeof args.response.result.action === "string"
      ? args.response.result.action
      : undefined;
  if (action === "accept") return "accepted";

  const result = await withLock(
    args.state,
    authorizationLockKey(parsedId.data),
    async (lock) => {
      const current = await readAuthorization(args.state, parsedId.data);
      if (!current || current.connectionId !== args.connectionId) return false;
      const completion = await finishAuthorization({
        authorization: current,
        response: cancelledMessage(current.requestId),
        state: args.state,
      });
      if (completion === "busy") return false;
      await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
      await deleteAuthorization(args.state, current, parsedId.data);
      return true;
    },
    {
      keepAlive: true,
      ttlMs: MUTATION_LOCK_TTL_MS,
      waitMs: LOCK_WAIT_MS,
    },
  );
  if (!result.acquired) {
    throw new Error("Timed out acquiring ACP authorization control");
  }
  return result.value ? "cancelled" : "ignored";
}

/** Finish an abandoned browser authorization while its connection stream is live. */
export async function expireAcpAuthorization(args: {
  connectionId: string;
  state: AcpState;
}): Promise<boolean> {
  const pointer = await readAuthorizationPointer(args.state, args.connectionId);
  if (!pointer || pointer.expiresAtMs > Date.now()) return false;

  const result = await withLock(
    args.state,
    authorizationLockKey(pointer.transactionId),
    async (lock) => {
      const authorization = await readAuthorization(
        args.state,
        pointer.transactionId,
      );
      if (!authorization || authorization.connectionId !== args.connectionId) {
        await deleteAuthorizationPointer(
          args.state,
          args.connectionId,
          pointer.transactionId,
        );
        return false;
      }
      if (authorization.expiresAtMs > Date.now()) return false;
      const completion = await finishAuthorization({
        authorization,
        response: cancelledMessage(
          authorization.requestId,
          "Junior sign-in request expired",
        ),
        state: args.state,
      });
      if (completion === "busy") return false;
      await fenceLock(args.state, lock, MUTATION_LOCK_TTL_MS);
      await deleteAuthorization(
        args.state,
        authorization,
        pointer.transactionId,
      );
      return true;
    },
    {
      keepAlive: true,
      ttlMs: MUTATION_LOCK_TTL_MS,
      waitMs: LOCK_WAIT_MS,
    },
  );
  if (!result.acquired) return false;
  return result.value;
}
