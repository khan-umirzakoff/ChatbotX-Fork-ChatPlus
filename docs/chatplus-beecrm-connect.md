# ChatPLUS connect handshake (BeeCRM, CONNECT-001)

ChatPLUS-owned feature. The contract is `docs/CHATPLUS-BEECRM-CONNECT.md` on branch
`docs/simple-mode-ux-inventory` (agreed with the BeeCRM architecture session on 2026-10-24).
This page covers what the ChatPLUS half does and how to configure it.

## What it does

An owner signed in to BeeCRM presses "ChatPLUS'ni ulash". BeeCRM sends the browser to the
ChatPLUS consent page. The owner picks one ChatPLUS workspace where they are an administrator
and allows access. BeeCRM then receives a workspace API token without anyone copying a key.

## Endpoints

| Step | Path | Auth |
| --- | --- | --- |
| Consent page | `GET /cp/connect/beecrm?response_type=code&client_id=beecrm&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256&beecrm_team_id=…&beecrm_user_id=…[&beecrm_team_name=…]` | ChatPLUS session; the chosen workspace needs `superAdmin` |
| Redirect back | `redirect_uri?code=…&state=…&iss=<ChatPLUS origin>`, or `?error=access_denied&state=…&iss=…` | — |
| Code exchange | `POST /api/chatplus/connect/token`, form body `grant_type=authorization_code&code&redirect_uri&code_verifier[&lead_hook_url]` | `Authorization: Basic base64(client_id:client_secret)` |
| Revoke | `POST /api/chatplus/connect/revoke`, form body `token=<access token>` | Basic client auth |

Token response:
`{access_token, token_type: "Bearer", token_id, scopes: ["inbox","contacts"], workspace: {id, name},
api_base, lead_hook_registered, beecrm_team_id, beecrm_user_id}`, sent with `Cache-Control: no-store`.

**Lead hook.** BeeCRM sends its CHATPLUS-BEECRM-001 receiver URL as `lead_hook_url` in the exchange.
ChatPLUS registers it as the workspace's `beecrm` external webhook (provider `make`) inside the
same transaction that mints the token, after an allowlist prefix check and the upstream SSRF
guard. The token has no `integrations` scope, so BeeCRM cannot add or re-create hooks through the
public API, and no stale request can bring a hook back after a disconnect. A refused
`lead_hook_url` answers `invalid_request` before the code is consumed.

## Rules the code enforces

- Unknown `client_id` or a `redirect_uri` that is not an exact allowlist match: an error page,
  never a redirect.
- PKCE S256 only. A code is 32 random bytes, kept only as a SHA-256 hash in Redis for 5 minutes,
  and consumed atomically (`GETDEL`) before any other check, so it is single-use even when the
  exchange fails.
- A code is bound to the issuer, the tenant, the client, the redirect URI, the PKCE challenge, the
  ChatPLUS workspace and user, and the BeeCRM team and user. The BeeCRM ids are echoed in the
  token response for BeeCRM to compare with its `state`.
- Issuer = origin of the `x-url` header that `proxy.ts` sets on every request, read the same way
  on the consent step and on the exchange. The tenant comes from that host
  (`resolveTenantByDomain`). The approving workspace, the code and the redeeming host must all
  have that tenant. Trusting `Host`/`X-Forwarded-*` is a deployment property shared with the rest
  of the app: the ingress must overwrite them.
- Support sessions and non-admins cannot approve. Workspaces scheduled for deletion are not
  offered and get no token.
- Token: permission `full`, scopes `inbox` and `contacts` (workspace-wide; the consent page says
  so), named `<client name> · <BeeCRM team> #<clientId>`. No refresh tokens.
- One link per ChatPLUS workspace. `chatplusConnectLinkService` (`packages/business/src/chatplus/`)
  runs every link change in one database transaction behind the same per-workspace advisory lock
  as `createToken`. Cache invalidation and audit records (with the workspace set) run after commit.
  - `replaceLink` (exchange): deletes the client's earlier tokens (names ending in ` #<clientId>`)
    and the workspace's `beecrm` hooks, mints the new token, and registers the new lead hook. All
    of it commits or none of it does, so a failed step keeps the old link. Deleting first frees a
    slot under the token cap.
  - `endLinkByTokenHash` (revoke): reads the presented token uncached, then re-checks it inside the
    lock. A token that a reconnect already replaced, a foreign token or an unknown token is a
    no-op that answers 200 (RFC 7009). Otherwise the token and the hooks go together.
  - `endLink` (settings): when the owner deletes the client's token in Settings → API tokens, the
    token and its hook go together in one transaction, through one marked registration block in
    the upstream `features/workspaces/actions/delete-workspace-token-action.ts`. Any other token is
    deleted by the upstream code as before.
- Limits: 60 requests a minute per IP before client authentication, 60 a minute per client after
  it; the body is a form, at most 16 KiB, counted while streaming.
- Failures are logged with the error name and code only, never the message or SQL parameters
  (which could carry a token hash); an unexpected error answers a bare `server_error`. A malformed
  client config logs only the error type.

## Upstream files touched

| File | Change |
| --- | --- |
| `packages/business/src/index.ts` | `export * from "./chatplus"` in a `// ChatPLUS` block |
| `apps/builder/src/features/workspaces/actions/delete-workspace-token-action.ts` | a `// ChatPLUS` block calling `endConnectLinkForToken`, and `const deleted = endedConnectLink \|\| (await …deleteToken(…))` (1 upstream change in the last three months) |

## Known limits

- Ownership is read from the token name (` #<clientId>`), since the fork adds no tables. A
  workspace admin who deliberately names a token that way would have it replaced on reconnect.
  Proper fix: an owner/issuer column on `WorkspaceApiToken` (upstream PR, needs a migration).
- If a workspace token is deleted by any path other than the settings action, the revoke endpoint
  or a reconnect (for example directly in the database), the lead hook stays. BeeCRM's 5-minute
  liveness check (contract §2) still disables its receiver on 401.
- The issuer is the origin of `x-url`, which `proxy.ts` builds from the public host and protocol
  and **without the port**. ChatPLUS must therefore serve the handshake on the default https port,
  and the ingress must overwrite `Host`/`X-Forwarded-*` (as the rest of the app already assumes for
  tenant resolution). An unknown host resolves to the root tenant, and the code is bound to the
  issuer host, so it cannot be redeemed on another host.

## Configuration

`CHATPLUS_CONNECT_CLIENTS` (builder environment), a JSON array:

```json
[
  {
    "clientId": "beecrm",
    "name": "BeeCRM",
    "secretSha256": ["<sha256 hex of the client secret>"],
    "redirectUris": ["https://api.beecrm.uz/api/integrations/chatplus/connect/callback/"],
    "leadHookUrlPrefixes": ["https://api.beecrm.uz/api/integrations/v1/chatplus/"]
  }
]
```

- Up to two `secretSha256` values, to rotate the secret without downtime. The plaintext secret is
  held only by BeeCRM (ADR-010 encrypted storage).
- `leadHookUrlPrefixes`: https, ending in `/` after a path, so the host cannot be extended. Without
  it no lead hook can be registered.
- `redirectUris` must be https. Add the BeeCRM sandbox callback when the BeeCRM half starts.
- A missing or malformed value disables the handshake: the consent page shows "link not valid"
  and the token endpoint answers `invalid_client`.

## Not in this slice

- The BeeCRM half: button, `state`/PKCE, server-side callback, `iss` check, encrypted storage,
  replacing and revoking the previous token on reconnect, and stopping all calls on 401.
- A "BeeCRM'dan uzish" button in ChatPLUS simple mode. Until then, the owner revokes the token in
  Settings → API tokens.
- Message events and the operator-identity field (upstream PR, contract §3).
