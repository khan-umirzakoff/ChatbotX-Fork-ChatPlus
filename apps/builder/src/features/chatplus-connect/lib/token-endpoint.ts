import "server-only"
import {
  externalWebhookService,
  isWorkspaceScheduledForDeletion,
  workspaceApiTokenService,
  workspaceService,
} from "@chatbotx.io/business"
import { SYSTEM_ACTOR, withAuditContext } from "@chatbotx.io/business/audit"
import {
  generateWorkspaceToken,
  hashToken,
} from "@chatbotx.io/business/workspace-api-token/credentials"
import type { WorkspaceApiTokenScope } from "@chatbotx.io/database/partials"
import { distributedLock } from "@chatbotx.io/redis"
import { logger } from "@/lib/log"
import { getGuestClientIp } from "@/lib/rate-limit/guest-rate-limit"
import { authenticateClient, type ConnectClient } from "./clients"
import { consumeConnectCode, getCacheRedis, verifyPkce } from "./code-store"
import { tenantForIssuer } from "./issuer"

/** What BeeCRM may do (contract §2): read/send/assign chats, read and update contacts, register its lead hook. */
export const CONNECT_TOKEN_SCOPES: WorkspaceApiTokenScope[] = [
  "inbox",
  "contacts",
  "integrations",
]
/** External-webhook event BeeCRM registers for CHATPLUS-BEECRM-001; removed when a link ends. */
const CLIENT_HOOK_EVENTS: Record<string, string[]> = { beecrm: ["beecrm"] }
const REQUESTS_PER_MINUTE_PER_IP = 60
const REQUESTS_PER_MINUTE_PER_CLIENT = 60
const LINK_LOCK_SECONDS = 15
const TOKEN_NAME_MAX = 100

export type EndpointResult = {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
}

const oauthError = (
  status: number,
  error: string,
  description?: string,
): EndpointResult => ({
  status,
  body: { error, ...(description ? { error_description: description } : {}) },
  ...(status === 401
    ? { headers: { "WWW-Authenticate": 'Basic realm="chatplus-connect"' } }
    : {}),
})

const slowDown = (): EndpointResult => ({
  ...oauthError(429, "slow_down"),
  headers: { "Retry-After": "60" },
})

/**
 * Tokens minted for a client end with ` #<clientId>`: the immutable id, not the
 * display name, so renaming the client in config never orphans its tokens.
 * shortcut: ownership is read from the token name because there is no link
 * table (no fork migrations); a workspace admin could name a token the same
 * way and have it replaced by a reconnect. Upgrade to a link table if the
 * fork ever gets its own migrations.
 */
const ownershipSuffix = (client: ConnectClient) => ` #${client.clientId}`

const tokenName = (client: ConnectClient, label: string) => {
  const suffix = ownershipSuffix(client)
  return `${`${client.name} · ${label}`.slice(0, TOKEN_NAME_MAX - suffix.length)}${suffix}`
}

const isClientToken = (client: ConnectClient, name: string) =>
  name.endsWith(ownershipSuffix(client))

async function isOverLimit(key: string, limit: number): Promise<boolean> {
  const redis = await getCacheRedis()
  const windowKey = `chatplus:connect:rate:${key}:${Math.floor(Date.now() / 60_000)}`
  const count = await redis.incr(windowKey)
  if (count === 1) {
    await redis.expire(windowKey, 60)
  }
  return count > limit
}

/** Unauthenticated requests are limited per IP before the client secret is checked (RFC 6749 §2.3.1). */
const isIpLimited = (headers: Headers) =>
  isOverLimit(`ip:${getGuestClientIp(headers)}`, REQUESTS_PER_MINUTE_PER_IP)

/** Serializes every link change of one workspace, so two exchanges cannot delete each other's tokens. */
const withLinkLock = <T>(workspaceId: string, fn: () => Promise<T>) =>
  distributedLock.runExclusive({
    key: `chatplus:connect:link:${workspaceId}`,
    timeoutInSeconds: LINK_LOCK_SECONDS,
    fn,
  })

/** Deletes the client's tokens in the workspace and its lead hooks. */
async function removeClientLink(client: ConnectClient, workspaceId: string) {
  const tokens = (
    await workspaceApiTokenService.listTokens({ workspaceId })
  ).filter((apiToken) => isClientToken(client, apiToken.name))
  for (const apiToken of tokens) {
    await workspaceApiTokenService.deleteToken({ workspaceId, id: apiToken.id })
  }
  const hooks = await externalWebhookService.listByWorkspaceAndEvents({
    workspaceId,
    events: CLIENT_HOOK_EVENTS[client.clientId] ?? [],
  })
  for (const hook of hooks) {
    await externalWebhookService.unregister({ workspaceId, id: hook.id })
  }
  return { removedTokens: tokens.length, removedHooks: hooks.length }
}

/** `POST /api/chatplus/connect/token` (RFC 6749 §4.1.3 with PKCE and RFC 9207 issuer binding). */
export async function exchangeConnectCode(props: {
  headers: Headers
  form: URLSearchParams
  issuer: string
}): Promise<EndpointResult> {
  const { headers, form, issuer } = props

  if (await isIpLimited(headers)) {
    return slowDown()
  }
  const client = await authenticateClient(headers.get("authorization"))
  if (!client) {
    return oauthError(401, "invalid_client")
  }
  if (
    await isOverLimit(
      `client:${client.clientId}`,
      REQUESTS_PER_MINUTE_PER_CLIENT,
    )
  ) {
    return slowDown()
  }
  if (form.get("grant_type") !== "authorization_code") {
    return oauthError(400, "unsupported_grant_type")
  }
  const bodyClientId = form.get("client_id")
  if (bodyClientId && bodyClientId !== client.clientId) {
    return oauthError(400, "invalid_request", "client_id mismatch")
  }

  // Consumed before any other check: a code is single-use even when the exchange fails.
  const record = await consumeConnectCode(form.get("code") ?? "")
  if (
    !(
      record &&
      issuer &&
      record.clientId === client.clientId &&
      record.issuer === issuer &&
      record.redirectUri === form.get("redirect_uri") &&
      verifyPkce(form.get("code_verifier") ?? "", record.codeChallenge)
    )
  ) {
    return oauthError(400, "invalid_grant")
  }

  let workspace: Awaited<ReturnType<typeof workspaceService.findById>>
  try {
    workspace = await workspaceService.findById({ id: record.workspaceId })
  } catch {
    return oauthError(400, "invalid_grant", "workspace unavailable")
  }
  // The tenant of the host that issued the code, of the host redeeming it, and of the workspace must agree.
  const tenantId = await tenantForIssuer(issuer)
  if (
    isWorkspaceScheduledForDeletion(workspace) ||
    record.tenantId !== tenantId ||
    workspace.tenantId !== tenantId
  ) {
    return oauthError(400, "invalid_grant", "workspace unavailable")
  }

  const { token, tokenHash, tokenPrefix } = await generateWorkspaceToken()
  const audit = {
    userId: record.userId,
    workspaceId: workspace.id,
    source: `chatplus-connect:${client.clientId}`,
  }
  let result: { tokenId: string; removedTokens: number; removedHooks: number }
  try {
    result = await withAuditContext(audit, () =>
      withLinkLock(workspace.id, async () => {
        // One link per workspace (contract A1): the earlier link and its lead hook go
        // first, which also frees a slot under the per-workspace token cap.
        const removed = await removeClientLink(client, workspace.id)
        const created = await workspaceApiTokenService.createToken({
          workspaceId: workspace.id,
          name: tokenName(client, record.beecrmTeamName ?? record.beecrmTeamId),
          permission: "full",
          tokenHash,
          tokenPrefix,
          scopes: CONNECT_TOKEN_SCOPES,
        })
        return { tokenId: created.id, ...removed }
      }),
    )
  } catch (err) {
    logger.warn(
      { err, workspaceId: workspace.id, clientId: client.clientId },
      "ChatPLUS connect: could not mint workspace token",
    )
    return oauthError(
      400,
      "invalid_request",
      "Could not create the workspace API token; check the token limit in ChatPLUS settings and connect again",
    )
  }

  logger.info(
    {
      workspaceId: workspace.id,
      clientId: client.clientId,
      tokenId: result.tokenId,
      beecrmTeamId: record.beecrmTeamId,
      replacedTokens: result.removedTokens,
      removedHooks: result.removedHooks,
    },
    "ChatPLUS connect: token issued",
  )

  return {
    status: 200,
    body: {
      access_token: token,
      token_type: "Bearer",
      token_id: result.tokenId,
      scopes: CONNECT_TOKEN_SCOPES,
      workspace: { id: workspace.id, name: workspace.name },
      api_base: `${issuer}/api`,
      beecrm_team_id: record.beecrmTeamId,
      beecrm_user_id: record.beecrmUserId,
    },
  }
}

/**
 * `POST /api/chatplus/connect/revoke` (RFC 7009): the client presents the token
 * it holds. Answers 200 whether or not the token exists, so it reveals nothing.
 */
export async function revokeConnectToken(props: {
  headers: Headers
  form: URLSearchParams
}): Promise<EndpointResult> {
  if (await isIpLimited(props.headers)) {
    return slowDown()
  }
  const client = await authenticateClient(props.headers.get("authorization"))
  if (!client) {
    return oauthError(401, "invalid_client")
  }
  if (
    await isOverLimit(
      `client:${client.clientId}`,
      REQUESTS_PER_MINUTE_PER_CLIENT,
    )
  ) {
    return slowDown()
  }
  const token = props.form.get("token")
  if (!token) {
    return oauthError(400, "invalid_request")
  }

  const found = await workspaceApiTokenService.findWorkspaceByTokenHash({
    tokenHash: await hashToken(token),
  })
  // Only a token this client minted ends the link; anything else is a silent no-op.
  if (!(found && isClientToken(client, found.apiToken.name))) {
    return { status: 200, body: {} }
  }

  const workspaceId = found.workspace.id
  const removed = await withAuditContext(
    {
      userId: SYSTEM_ACTOR,
      workspaceId,
      source: `chatplus-connect:${client.clientId}`,
    },
    () =>
      withLinkLock(workspaceId, () => removeClientLink(client, workspaceId)),
  )

  logger.info(
    { workspaceId, clientId: client.clientId, ...removed },
    "ChatPLUS connect: link revoked",
  )
  return { status: 200, body: {} }
}
