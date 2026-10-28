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
| Code exchange | `POST /api/chatplus/connect/token`, form body `grant_type=authorization_code&code&redirect_uri&code_verifier` | `Authorization: Basic base64(client_id:client_secret)` |
| Revoke | `POST /api/chatplus/connect/revoke`, form body `token=<access token>` | Basic client auth |

Token response:
`{access_token, token_type: "Bearer", token_id, scopes: ["inbox","contacts","integrations"],
workspace: {id, name}, api_base, beecrm_team_id, beecrm_user_id}`, sent with `Cache-Control: no-store`.

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
- Token: permission `full`, scopes `inbox`, `contacts`, `integrations` (workspace-wide; the consent
  page says so), named `<client name> · <BeeCRM team> #<clientId>`. Minting and deletion run inside
  the audit context of the approving user (exchange) or the system actor (revoke). No refresh
  tokens.
- One link per ChatPLUS workspace. `chatplusConnectLinkService` (`packages/business/src/chatplus/`)
  runs every link change in one database transaction behind the same per-workspace advisory lock
  as `createToken`:
  - `replaceLink` (exchange): deletes the client's earlier tokens (names ending in ` #<clientId>`)
    and the workspace's `beecrm` lead hooks, then mints the new token. All of it commits or none of
    it does, so a failed mint keeps the old link. Deleting first frees a slot under the token cap.
  - `endLink` (revoke): re-reads the presented token inside the lock. If a reconnect already
    replaced it, nothing happens and the new link survives; otherwise the token and the hooks go.
  - `removeHooksForToken` (settings): see below.
  Cache invalidation and audit records run after commit.
- Deleting the client's token in ChatPLUS Settings → API tokens also removes the client's lead
  hooks, through one marked registration line in the upstream
  `features/workspaces/actions/delete-workspace-token-action.ts`. It fails closed: if the hooks
  cannot be removed, the deletion stops and the owner retries.
- Revoke answers 200 for unknown, foreign or already-replaced tokens (RFC 7009).
- Limits: 60 requests a minute per IP before client authentication, 60 a minute per client after
  it; the body is a form, at most 16 KiB, counted while streaming.
- Failures are logged with the error name and code only, never the message or SQL parameters
  (which could carry a token hash).

## Upstream files touched

| File | Change |
| --- | --- |
| `packages/business/src/index.ts` | `export * from "./chatplus"` in a `// ChatPLUS` block |
| `apps/builder/src/features/workspaces/actions/delete-workspace-token-action.ts` | one call to `removeConnectHooksBeforeTokenDelete` in a `// ChatPLUS` block (1 upstream change in the last three months) |

## Known limits

- Ownership is read from the token name (` #<clientId>`), since the fork adds no tables. A
  workspace admin who deliberately names a token that way would have it replaced on reconnect.
  Proper fix: an owner/issuer column on `WorkspaceApiToken` (upstream PR, needs a migration).
- If a workspace token is deleted by any path other than the settings action, the revoke endpoint
  or a reconnect (for example directly in the database), the lead hooks stay. BeeCRM's 5-minute
  liveness check (contract §2) still disables its receiver on 401.

## Configuration

`CHATPLUS_CONNECT_CLIENTS` (builder environment), a JSON array:

```json
[
  {
    "clientId": "beecrm",
    "name": "BeeCRM",
    "secretSha256": ["<sha256 hex of the client secret>"],
    "redirectUris": ["https://api.beecrm.uz/api/integrations/chatplus/connect/callback/"]
  }
]
```

- Up to two `secretSha256` values, to rotate the secret without downtime. The plaintext secret is
  held only by BeeCRM (ADR-010 encrypted storage).
- `redirectUris` must be https. Add the BeeCRM sandbox callback when the BeeCRM half starts.
- A missing or malformed value disables the handshake: the consent page shows "link not valid"
  and the token endpoint answers `invalid_client`.

## Not in this slice

- The BeeCRM half: button, `state`/PKCE, server-side callback, `iss` check, encrypted storage,
  replacing and revoking the previous token on reconnect, and stopping all calls on 401.
- A "BeeCRM'dan uzish" button in ChatPLUS simple mode. Until then, the owner revokes the token in
  Settings → API tokens.
- Message events and the operator-identity field (upstream PR, contract §3).
