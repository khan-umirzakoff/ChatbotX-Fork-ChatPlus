import "server-only"
import {
  externalWebhookService,
  isWorkspaceScheduledForDeletion,
  workspaceApiTokenService,
  workspaceService,
} from "@chatbotx.io/business"
import {
  generateWorkspaceToken,
  hashToken,
} from "@chatbotx.io/business/workspace-api-token/credentials"
import type { WorkspaceApiTokenScope } from "@chatbotx.io/database/partials"
import { logger } from "@/lib/log"
import { authenticateClient, type ConnectClient } from "./clients"
import { consumeConnectCode, getCacheRedis, verifyPkce } from "./code-store"

/** What BeeCRM may do (docs/chatplus-beecrm-connect.md §2): read/send/assign chats, read contacts, register its lead hook. */
export const CONNECT_TOKEN_SCOPES: WorkspaceApiTokenScope[] = [
  "inbox",
  "contacts",
  "integrations",
]
/** External-webhook event BeeCRM registers for CHATPLUS-BEECRM-001; removed on revoke. */
const CLIENT_HOOK_EVENTS: Record<string, string[]> = { beecrm: ["beecrm"] }
const REQUESTS_PER_MINUTE = 60

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

const tokenNamePrefix = (client: ConnectClient) => `${client.name} · `

/** Deletes the given client tokens and the client's lead hooks in the workspace. */
async function removeClientLink(props: {
  client: ConnectClient
  workspaceId: string
  tokenIds: string[]
}) {
  const { client, workspaceId, tokenIds } = props
  for (const id of tokenIds) {
    await workspaceApiTokenService.deleteToken({ workspaceId, id })
  }
  const hooks = await externalWebhookService.listByWorkspaceAndEvents({
    workspaceId,
    events: CLIENT_HOOK_EVENTS[client.clientId] ?? [],
  })
  for (const hook of hooks) {
    await externalWebhookService.unregister({ workspaceId, id: hook.id })
  }
  return hooks.length
}

async function isRateLimited(client: ConnectClient): Promise<boolean> {
  const redis = await getCacheRedis()
  const key = `chatplus:connect:rate:${client.clientId}:${Math.floor(Date.now() / 60_000)}`
  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, 60)
  }
  return count > REQUESTS_PER_MINUTE
}

/** `POST /api/chatplus/connect/token` (RFC 6749 §4.1.3 with PKCE and RFC 9207 issuer binding). */
export async function exchangeConnectCode(props: {
  authorization: string | null
  form: URLSearchParams
  issuer: string
}): Promise<EndpointResult> {
  const { authorization, form, issuer } = props

  const client = await authenticateClient(authorization)
  if (!client) {
    return oauthError(401, "invalid_client")
  }
  if (await isRateLimited(client)) {
    return { ...oauthError(429, "slow_down"), headers: { "Retry-After": "60" } }
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
    !record ||
    record.clientId !== client.clientId ||
    record.issuer !== issuer ||
    record.redirectUri !== form.get("redirect_uri") ||
    !verifyPkce(form.get("code_verifier") ?? "", record.codeChallenge)
  ) {
    return oauthError(400, "invalid_grant")
  }

  let workspace: Awaited<ReturnType<typeof workspaceService.findById>>
  try {
    workspace = await workspaceService.findById({ id: record.workspaceId })
  } catch {
    return oauthError(400, "invalid_grant", "workspace unavailable")
  }
  if (isWorkspaceScheduledForDeletion(workspace)) {
    return oauthError(400, "invalid_grant", "workspace unavailable")
  }

  const { token, tokenHash, tokenPrefix } = await generateWorkspaceToken()
  const label = record.beecrmTeamName ?? record.beecrmTeamId
  let created: Awaited<ReturnType<typeof workspaceApiTokenService.createToken>>
  try {
    created = await workspaceApiTokenService.createToken({
      workspaceId: workspace.id,
      name: `${tokenNamePrefix(client)}${label}`.slice(0, 100),
      permission: "full",
      tokenHash,
      tokenPrefix,
      scopes: CONNECT_TOKEN_SCOPES,
    })
  } catch (err) {
    // The only expected failure is the per-workspace token cap.
    logger.warn(
      { err, workspaceId: workspace.id, clientId: client.clientId },
      "ChatPLUS connect: could not mint workspace token",
    )
    return oauthError(
      400,
      "invalid_request",
      "Workspace API token limit reached; remove an unused token in ChatPLUS settings",
    )
  }

  // One link per workspace (contract A1): a new link replaces any earlier one,
  // including its lead hook, so a previous BeeCRM workspace stops receiving leads.
  const previousTokenIds = (
    await workspaceApiTokenService.listTokens({ workspaceId: workspace.id })
  )
    .filter(
      (apiToken) =>
        apiToken.id !== created.id &&
        apiToken.name.startsWith(tokenNamePrefix(client)),
    )
    .map((apiToken) => apiToken.id)
  const removedHooks = await removeClientLink({
    client,
    workspaceId: workspace.id,
    tokenIds: previousTokenIds,
  })

  logger.info(
    {
      workspaceId: workspace.id,
      clientId: client.clientId,
      tokenId: created.id,
      beecrmTeamId: record.beecrmTeamId,
      replacedTokens: previousTokenIds.length,
      removedHooks,
    },
    "ChatPLUS connect: token issued",
  )

  return {
    status: 200,
    body: {
      access_token: token,
      token_type: "Bearer",
      token_id: created.id,
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
  authorization: string | null
  form: URLSearchParams
}): Promise<EndpointResult> {
  const client = await authenticateClient(props.authorization)
  if (!client) {
    return oauthError(401, "invalid_client")
  }
  if (await isRateLimited(client)) {
    return { ...oauthError(429, "slow_down"), headers: { "Retry-After": "60" } }
  }
  const token = props.form.get("token")
  if (!token) {
    return oauthError(400, "invalid_request")
  }

  const found = await workspaceApiTokenService.findWorkspaceByTokenHash({
    tokenHash: await hashToken(token),
  })
  // Only tokens this client minted (named by the handshake) can be revoked here.
  if (!found?.apiToken.name.startsWith(tokenNamePrefix(client))) {
    return { status: 200, body: {} }
  }

  const workspaceId = found.workspace.id
  const removedHooks = await removeClientLink({
    client,
    workspaceId,
    tokenIds: [found.apiToken.id],
  })

  logger.info(
    {
      workspaceId,
      clientId: client.clientId,
      tokenId: found.apiToken.id,
      removedHooks,
    },
    "ChatPLUS connect: token revoked",
  )
  return { status: 200, body: {} }
}
