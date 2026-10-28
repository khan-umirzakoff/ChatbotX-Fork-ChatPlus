"use server"

import { workspaceApiTokenService } from "@chatbotx.io/business"
import { returnValidationErrors } from "next-safe-action"
import { endConnectLinkForToken } from "@/features/chatplus-connect/lib/link-client"
import {
  type WorkspaceIdRequestParams,
  workspaceIdrequestParams,
} from "@/features/common/schema"
import { workspaceActionClient } from "@/lib/safe-action"
import { requireWorkspaceTokenSuperAdmin } from "../lib/require-workspace-token-super-admin"
import {
  type DeleteWorkspaceTokenRequest,
  deleteWorkspaceTokenRequest,
} from "../schema/action"

export const deleteWorkspaceTokenAction = workspaceActionClient
  .bindArgsSchemas(workspaceIdrequestParams)
  .inputSchema(deleteWorkspaceTokenRequest)
  .action(
    async ({
      bindArgsParsedInputs: [workspaceId],
      parsedInput,
    }: {
      bindArgsParsedInputs: WorkspaceIdRequestParams
      parsedInput: DeleteWorkspaceTokenRequest
    }) => {
      await requireWorkspaceTokenSuperAdmin(workspaceId)

      // ChatPLUS: a connect token is deleted together with its lead hook (CONNECT-001).
      const endedConnectLink = await endConnectLinkForToken({
        workspaceId,
        tokenId: parsedInput.id,
      })
      // end ChatPLUS
      const deleted =
        endedConnectLink ||
        (await workspaceApiTokenService.deleteToken({
          workspaceId,
          id: parsedInput.id,
        }))

      if (!deleted) {
        return returnValidationErrors(deleteWorkspaceTokenRequest, {
          _errors: ["Token no longer exists"],
        })
      }
    },
  )
