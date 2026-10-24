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
- A code is bound to the issuer (the ChatPLUS origin, i.e. the tenant host), the client, the
  redirect URI, the PKCE challenge, the ChatPLUS workspace and user, and the BeeCRM team and user.
  The BeeCRM ids are echoed in the token response for BeeCRM to compare with its `state`.
- Support sessions and non-admins cannot approve. Workspaces scheduled for deletion are not
  offered and get no token.
- Token: permission `full`, scopes `inbox`, `contacts`, `integrations`, named
  `<client name> · <BeeCRM team>`, audit-logged by `workspaceApiTokenService`. No refresh tokens.
  The per-workspace token cap applies (the exchange answers `invalid_request`).
- One link per ChatPLUS workspace: a successful exchange deletes the client's earlier tokens in
  that workspace and its `beecrm` lead hooks, so a previously linked BeeCRM workspace stops
  receiving leads (BeeCRM re-registers its hook with the new token).
- Revoke deletes only tokens whose name starts with the client's prefix, and removes the
  workspace's `beecrm` external webhooks. It answers 200 for unknown tokens (RFC 7009).
- 60 requests a minute per client on the token and revoke endpoints.

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
