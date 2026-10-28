# Proposal for upstream ChatbotX: record who issued a workspace API token

Status: draft for an upstream ChatbotX issue. Not posted: it is filed once the product owner
approves posting it.

## Problem

`WorkspaceApiToken` has a free-text `name` and no record of who or what issued the token. A
system flow that mints tokens on a workspace's behalf therefore has no reliable way to find the
tokens it owns again. Examples are an OAuth-style "connect" handshake with a partner app, or the
`{{api_key}}` default token, which today uses its own column path. Such a flow needs this to
replace a token on reconnect or revoke it on disconnect, and the only option is matching the name.
A workspace admin can give any token any name, so a name match can hit an admin's own token.

## Proposal

- Add a nullable `issuedBy` jsonb column to `WorkspaceApiToken`, for example
  `{ "kind": "connect", "clientId": "<partner>" }`. It is `null` for tokens created in Settings or
  through the API.
- Only internal services set it. The settings UI and the public API never accept it as input.
- Show it read-only in Settings → API tokens ("Created by BeeCRM connect"), so an owner can see why
  the token exists.
- Add a repository and service method `listByIssuer(workspaceId, issuedBy)` for system flows.
- Optional, same PR or a follow-up: an `ExternalWebhook.createdByTokenId` (nullable FK, `ON DELETE
  CASCADE` or cleared by the token delete path), so hooks registered with a token disappear with
  it. Today a hook outlives the token that registered it and keeps receiving contact data.

## Migration

One nullable column (two with the optional hook link), no backfill. Existing tokens keep
`issuedBy = null`.

## Why upstream

It is generic. Any partner integration that links accounts needs it, and so do agent tools that
mint scoped tokens. It also closes the "deleted key, hook still sending data" gap for every
integrator, not just ours.
