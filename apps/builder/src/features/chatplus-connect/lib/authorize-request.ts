import { z } from "zod"

const externalId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/** Query of `/cp/connect/<client>`: OAuth 2.0 authorization request with PKCE (S256 only). */
export const authorizeRequestSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(40),
  redirect_uri: z.string().min(1).max(500),
  state: z.string().min(16).max(512),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal("S256"),
  beecrm_team_id: externalId,
  beecrm_user_id: externalId,
  beecrm_team_name: z.string().trim().min(1).max(100).optional(),
})

export type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>

/** Next.js search params may repeat a key; a repeated key is treated as invalid, not merged. */
export function singleValuedParams(
  params: Record<string, string | string[] | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
}

export function buildClientRedirect(
  redirectUri: string,
  params: Record<string, string>,
): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}
