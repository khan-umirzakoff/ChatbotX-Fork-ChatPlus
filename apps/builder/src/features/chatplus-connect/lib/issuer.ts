import "server-only"
import { resolveTenantByDomain } from "@chatbotx.io/auth/tenant"

/**
 * The issuer is the public origin of the request as computed by `proxy.ts`,
 * which overwrites `x-url` on every matched request (pages, actions and
 * `/api/*`). Using that one header on both sides of the handshake keeps the
 * value identical between the consent step and the code exchange.
 */
export function issuerFromHeaders(headers: Headers): string {
  const url = headers.get("x-url")
  if (!url) {
    return ""
  }
  try {
    return new URL(url).origin
  } catch {
    return ""
  }
}

/** Tenant of the host the issuer names (white-label hosts map to their tenant). */
export async function tenantForIssuer(issuer: string): Promise<string> {
  return await resolveTenantByDomain(new URL(issuer).hostname)
}
