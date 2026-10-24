import "server-only"
import { createHash } from "node:crypto"
import { hashToken } from "@chatbotx.io/business/workspace-api-token/credentials"
import { cacheConnections } from "@chatbotx.io/redis"

const CODE_TTL_SECONDS = 300
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

/** Everything a code is bound to; checked again when it is exchanged. */
export type ConnectCodeRecord = {
  issuer: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  workspaceId: string
  userId: string
  beecrmTeamId: string
  beecrmUserId: string
  beecrmTeamName?: string
}

const codeKey = (codeHash: string) => `chatplus:connect:code:${codeHash}`

// Renamed without the `use` prefix so lint does not mistake the Redis getter for a
// React hook; `useExisting` reads module state, not `this`, so it is safe unbound.
export const { useExisting: getCacheRedis } = cacheConnections

/** Issues a single-use code (32 random bytes). Only its SHA-256 hash is stored, for 5 minutes. */
export async function issueConnectCode(
  record: ConnectCodeRecord,
): Promise<string> {
  const code = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  )
  const redis = await getCacheRedis()
  await redis.set(
    codeKey(await hashToken(code)),
    JSON.stringify(record),
    "EX",
    CODE_TTL_SECONDS,
    "NX",
  )
  return code
}

/** Atomically reads and deletes the code, so it can be redeemed once even under concurrent requests. */
export async function consumeConnectCode(
  code: string,
): Promise<ConnectCodeRecord | null> {
  if (!CODE_PATTERN.test(code)) {
    return null
  }
  const redis = await getCacheRedis()
  const value = await redis.getdel(codeKey(await hashToken(code)))
  if (!value) {
    return null
  }
  try {
    return JSON.parse(value) as ConnectCodeRecord
  } catch {
    return null
  }
}

/** RFC 7636 S256: BASE64URL(SHA256(code_verifier)) must equal the stored challenge. */
export function verifyPkce(codeVerifier: string, codeChallenge: string) {
  if (!VERIFIER_PATTERN.test(codeVerifier)) {
    return false
  }
  return (
    createHash("sha256").update(codeVerifier).digest("base64url") ===
    codeChallenge
  )
}
