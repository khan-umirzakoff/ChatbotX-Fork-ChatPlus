import "server-only"
import { timingSafeEqual } from "node:crypto"
import { hashToken } from "@chatbotx.io/business/workspace-api-token/credentials"
import { z } from "zod"
import { logger } from "@/lib/log"

/**
 * Registered confidential clients of the ChatPLUS connect handshake
 * (docs/chatplus-beecrm-connect.md). v1 has one: BeeCRM.
 *
 * `CHATPLUS_CONNECT_CLIENTS` is a JSON array. Secrets are stored only as
 * SHA-256 hex; two are allowed so a secret can be rotated without downtime.
 * Redirect URIs are compared as exact strings.
 */
const connectClientSchema = z.object({
  clientId: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(40),
  secretSha256: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .min(1)
    .max(2),
  redirectUris: z
    .array(z.url().refine((uri) => uri.startsWith("https://")))
    .min(1)
    .max(5),
})

export type ConnectClient = z.infer<typeof connectClientSchema>

export function listConnectClients(): ConnectClient[] {
  const raw = process.env.CHATPLUS_CONNECT_CLIENTS
  if (!raw) {
    return []
  }
  try {
    return z.array(connectClientSchema).parse(JSON.parse(raw))
  } catch (err) {
    // Fail closed: a malformed config disables the handshake instead of
    // accepting a half-parsed client list.
    logger.error({ err }, "Invalid CHATPLUS_CONNECT_CLIENTS; connect disabled")
    return []
  }
}

export function findConnectClient(clientId: string): ConnectClient | undefined {
  return listConnectClients().find((client) => client.clientId === clientId)
}

export function isAllowedRedirectUri(
  client: ConnectClient,
  redirectUri: string,
): boolean {
  return client.redirectUris.includes(redirectUri)
}

export async function verifyClientSecret(
  client: ConnectClient,
  secret: string,
): Promise<boolean> {
  const presented = Buffer.from(await hashToken(secret), "hex")
  let matched = false
  for (const stored of client.secretSha256) {
    // Compare against every stored hash so timing does not reveal which one matched.
    matched = timingSafeEqual(presented, Buffer.from(stored, "hex")) || matched
  }
  return matched
}

/** Parses `Authorization: Basic base64(client_id:client_secret)` (RFC 6749 §2.3.1). */
export async function authenticateClient(
  authorization: string | null,
): Promise<ConnectClient | undefined> {
  if (!authorization?.startsWith("Basic ")) {
    return
  }
  const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8")
  const separator = decoded.indexOf(":")
  if (separator <= 0) {
    return
  }
  let clientId: string
  let secret: string
  try {
    clientId = decodeURIComponent(decoded.slice(0, separator))
    secret = decodeURIComponent(decoded.slice(separator + 1))
  } catch {
    return
  }
  const client = findConnectClient(clientId)
  if (!client) {
    return
  }
  return (await verifyClientSecret(client, secret)) ? client : undefined
}
