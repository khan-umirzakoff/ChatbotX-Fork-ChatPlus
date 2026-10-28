"use server"

import { workspaceApiTokenService } from "@chatbotx.io/business"
import { returnValidationErrors } from "next-safe-action"
import { removeConnectHooksBeforeTokenDelete } from "@/features/chatplus-connect/lib/link-client"
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

      // ChatPLUS: a deleted connect token takes its lead hooks with it (CONNECT-001).
      await removeConnectHooksBeforeTokenDelete({
        workspaceId,
        tokenId: parsedInput.id,
      })
      // end ChatPLUS

      const deleted = await workspaceApiTokenService.deleteToken({
        workspaceId,
        id: parsedInput.id,
      })

      if (!deleted) {
        return returnValidationErrors(deleteWorkspaceTokenRequest, {
          _errors: ["Token no longer exists"],
        })
      }
    },
  )
