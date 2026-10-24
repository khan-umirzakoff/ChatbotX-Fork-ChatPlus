"use server"

import { ChatbotXException } from "@chatbotx.io/business/errors"
import { headers } from "next/headers"
import { getChatplusTranslations } from "@/features/chatplus-core/i18n"
import { workspaceIdrequestParams } from "@/features/common/schema"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import { workspaceActionClient } from "@/lib/safe-action"
import {
  authorizeRequestSchema,
  buildClientRedirect,
} from "../lib/authorize-request"
import { findConnectClient, isAllowedRedirectUri } from "../lib/clients"
import { issueConnectCode } from "../lib/code-store"
import { issuerFromHeaders, tenantForIssuer } from "../lib/issuer"

/**
 * The owner approves the connect request for one workspace. Returns the client
 * redirect carrying `code`, `state` and `iss` (RFC 9207). Exempt from
 * AGENTS.md invariant 23: it is the browser step of an OAuth connect and it
 * mints a workspace API token, which a workspace token must never do.
 */
export const approveConnectAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(authorizeRequestSchema)
  .action(async ({ ctx, parsedInput }) => {
    const t = await getChatplusTranslations("connect")
    if (ctx.isSupportSession) {
      throw new ChatbotXException(t("errorSupportSession"), "forbidden", 403)
    }
    // Minting an API token needs superAdmin, as in requireWorkspaceTokenSuperAdmin.
    if (!hasWorkspacePermission(ctx.workspaceMemberPermissions, "superAdmin")) {
      throw new ChatbotXException(t("errorNotAdmin"), "forbidden", 403)
    }

    const client = findConnectClient(parsedInput.client_id)
    const issuer = issuerFromHeaders(await headers())
    if (
      !(
        client &&
        isAllowedRedirectUri(client, parsedInput.redirect_uri) &&
        issuer
      )
    ) {
      throw new ChatbotXException(t("errorInvalidRequest"), "badRequest", 400)
    }

    // The workspace must belong to the tenant of the host the owner is on.
    const tenantId = await tenantForIssuer(issuer)
    if (ctx.workspace.tenantId !== tenantId) {
      throw new ChatbotXException(t("errorInvalidRequest"), "badRequest", 400)
    }

    const code = await issueConnectCode({
      issuer,
      tenantId,
      clientId: client.clientId,
      redirectUri: parsedInput.redirect_uri,
      codeChallenge: parsedInput.code_challenge,
      workspaceId: ctx.workspaceId,
      userId: ctx.user.id,
      beecrmTeamId: parsedInput.beecrm_team_id,
      beecrmUserId: parsedInput.beecrm_user_id,
      beecrmTeamName: parsedInput.beecrm_team_name,
    })

    return {
      redirectUrl: buildClientRedirect(parsedInput.redirect_uri, {
        code,
        state: parsedInput.state,
        iss: issuer,
      }),
    }
  })
