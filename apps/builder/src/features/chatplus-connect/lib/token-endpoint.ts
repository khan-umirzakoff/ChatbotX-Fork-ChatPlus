import "server-only"
import {
  chatplusConnectLinkService,
  isWorkspaceScheduledForDeletion,
  workspaceService,
} from "@chatbotx.io/business"
import { SYSTEM_ACTOR, withAuditContext } from "@chatbotx.io/business/audit"
import {
  generateWorkspaceToken,
  hashToken,
} from "@chatbotx.io/business/workspace-api-token/credentials"
import type { WorkspaceApiTokenScope } from "@chatbotx.io/database/partials"
import { logger } from "@/lib/log"
import { getGuestClientIp } from "@/lib/rate-limit/guest-rate-limit"
import {
  authenticateClient,
  type ConnectClient,
  isAllowedLeadHookUrl,
} from "./clients"
import { consumeConnectCode, getCacheRedis, verifyPkce } from "./code-store"
import { tenantForIssuer } from "./issuer"
import { leadHookEvent, linkClient, ownershipSuffix } from "./link-client"

/**
 * What BeeCRM may do (contract §2): read/send/assign chats, read and update
 * contacts. No `integrations` scope: the lead hook is registered by the
 * exchange itself, so the client cannot add or re-create hooks on its own.
 */
export const CONNECT_TOKEN_SCOPES: WorkspaceApiTokenScope[] = [
  "inbox",
  "contacts",
]
const REQUESTS_PER_MINUTE_PER_IP = 60
const REQUESTS_PER_MINUTE_PER_CLIENT = 60
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

const tokenName = (client: ConnectClient, label: string) => {
  const suffix = ownershipSuffix(client.clientId)
  return `${`${client.name} · ${label}`.slice(0, TOKEN_NAME_MAX - suffix.length)}${suffix}`
}

/** Logs a failure without the error message, stack or SQL parameters, which can carry token hashes. */
export const errorShape = (err: unknown) => ({
  name: err instanceof Error ? err.name : typeof err,
  code: (err as { code?: unknown })?.code,
})

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
  // Checked before the code is consumed, so a wrong hook URL does not burn the code.
  const leadHookUrl = form.get("lead_hook_url")
  const hookEvent = leadHookEvent(client.clientId)
  if (
    leadHookUrl &&
    !(hookEvent && isAllowedLeadHookUrl(client, leadHookUrl))
  ) {
    return oauthError(400, "invalid_request", "lead_hook_url not allowed")
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
  let result: Awaited<ReturnType<typeof chatplusConnectLinkService.replaceLink>>
  try {
    result = await withAuditContext(audit, () =>
      chatplusConnectLinkService.replaceLink({
        workspaceId: workspace.id,
        client: linkClient(client.clientId),
        token: {
          name: tokenName(client, record.beecrmTeamName ?? record.beecrmTeamId),
          tokenHash,
          tokenPrefix,
          scopes: CONNECT_TOKEN_SCOPES,
        },
        leadHook:
          leadHookUrl && hookEvent
            ? { url: leadHookUrl, event: hookEvent }
            : undefined,
      }),
    )
  } catch (err) {
    logger.warn(
      {
        err: errorShape(err),
        workspaceId: workspace.id,
        clientId: client.clientId,
      },
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
      replacedTokens: result.replacedTokens,
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
      lead_hook_registered: result.leadHookRegistered,
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

  const tokenHash = await hashToken(token)
  // Uncached lookup and a re-check inside the lock (the service): only this
  // client's live token ends a link; a replaced or foreign token is a no-op.
  const removed = await withAuditContext(
    { userId: SYSTEM_ACTOR, source: `chatplus-connect:${client.clientId}` },
    () =>
      chatplusConnectLinkService.endLinkByTokenHash({
        tokenHash,
        client: linkClient(client.clientId),
      }),
  )
  if (!removed) {
    return { status: 200, body: {} }
  }

  logger.info(
    {
      workspaceId: removed.workspaceId,
      clientId: client.clientId,
      tokenId: removed.tokenId,
      removedHooks: removed.removedHooks,
    },
    "ChatPLUS connect: link revoked",
  )
  return { status: 200, body: {} }
}
