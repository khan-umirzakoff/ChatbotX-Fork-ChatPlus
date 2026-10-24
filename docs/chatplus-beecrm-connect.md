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
- One link per ChatPLUS workspace, serialized by a per-workspace Redis lock: an exchange first
  deletes the client's earlier tokens (those ending in ` #<clientId>`) and the workspace's
  `beecrm` lead hooks, then mints the new token. Deleting first frees a slot under the
  per-workspace token cap; if minting still fails, the exchange answers `invalid_request` and the
  owner connects again. BeeCRM re-registers its lead hook with the new token.
- Revoke ends the link the presented token belongs to (same cleanup, same lock) when that token
  ends in ` #<clientId>`. It answers 200 for unknown or foreign tokens (RFC 7009).
- Limits: 60 requests a minute per IP before client authentication, 60 a minute per client after
  it; the body is a form, at most 16 KiB, counted while streaming.

## Known limits

- **Deleting the key in ChatPLUS settings does not remove the lead hook.** The upstream settings
  screen deletes only the token, and the `make` step keeps posting leads to the BeeCRM hook. The
  consent page says so. Until simple mode has its own "BeeCRM'dan uzish" button (it will call the
  same cleanup), BeeCRM bounds the window: it checks the token at least every 5 minutes and, on
  401, disables its receiver secret so further posts are refused. Proper fix upstream: link
  external webhooks to the token that registered them (contract §3 upstream PR list).
- Ownership is read from the token name (` #<clientId>`), since the fork adds no tables. A
  workspace admin who names a token the same way would have it replaced on reconnect.

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
