import {
  and,
  type DatabaseClient,
  db,
  eq,
  inArray,
} from "@chatbotx.io/database/client"
import type {
  TokenHash,
  WorkspaceApiTokenScope,
} from "@chatbotx.io/database/partials"
import { workspaceApiTokenRepository } from "@chatbotx.io/database/repositories"
import { externalWebhookModel } from "@chatbotx.io/database/schema"
import { BaseService } from "../base.service"
import { logger } from "../logger"
import {
  workspaceApiTokenCacheTag,
  workspaceApiTokenService,
} from "../workspace-api-token/service"

/**
 * A ChatPLUS connect link (CONNECT-001): one client token in a workspace plus
 * the client's lead hooks. Every change runs in one transaction behind the
 * same per-workspace advisory lock as `createToken`, so replacing, ending and
 * token deletion cannot interleave, and a failed mint leaves the old link
 * intact.
 */
export type ConnectLinkClient = {
  /** Token names this client minted end with this marker. */
  isClientToken: (tokenName: string) => boolean
  /** External-webhook events the client registers (its lead hooks). */
  hookEvents: string[]
}

class ChatplusConnectLinkService extends BaseService {
  private async removeHooks(
    workspaceId: string,
    hookEvents: string[],
    tx: DatabaseClient,
  ): Promise<number> {
    if (hookEvents.length === 0) {
      return 0
    }
    const rows = await tx
      .delete(externalWebhookModel)
      .where(
        and(
          eq(externalWebhookModel.workspaceId, workspaceId),
          inArray(externalWebhookModel.event, hookEvents),
        ),
      )
      .returning({ id: externalWebhookModel.id })
    return rows.length
  }

  /** Cache invalidation and audit run only after commit, so a rollback never leaves either behind. */
  private async afterCommit(
    workspaceId: string,
    entries: { action: "create" | "delete"; detail: string }[],
  ) {
    try {
      await this.invalidateCacheTags(workspaceApiTokenCacheTag(workspaceId))
    } catch (err) {
      logger.warn(
        { err, workspaceId },
        "connect link: cache invalidation failed",
      )
    }
    for (const entry of entries) {
      try {
        await this.audit(entry.action, entry.detail)
      } catch (err) {
        logger.warn({ err, workspaceId }, "connect link: audit record failed")
      }
    }
  }

  /** Ends any earlier link of the client in the workspace and mints the new token, atomically. */
  async replaceLink(props: {
    workspaceId: string
    client: ConnectLinkClient
    token: {
      name: string
      tokenHash: TokenHash
      tokenPrefix: string
      scopes: WorkspaceApiTokenScope[]
    }
  }) {
    const { workspaceId, client, token } = props
    const result = await db.transaction(async (tx) => {
      await workspaceApiTokenRepository.lockWorkspaceTokens(workspaceId, tx)
      const previous = (
        await workspaceApiTokenRepository.listByWorkspaceId(workspaceId, tx)
      ).filter((apiToken) => client.isClientToken(apiToken.name))
      for (const apiToken of previous) {
        await workspaceApiTokenRepository.deleteByIdForWorkspace(
          { id: apiToken.id, workspaceId },
          tx,
        )
      }
      const removedHooks = await this.removeHooks(
        workspaceId,
        client.hookEvents,
        tx,
      )
      // Same tx: the cap count already sees the deleted rows.
      const created = await workspaceApiTokenService.createToken({
        workspaceId,
        name: token.name,
        permission: "full",
        tokenHash: token.tokenHash,
        tokenPrefix: token.tokenPrefix,
        scopes: token.scopes,
        tx,
      })
      return { created, previous, removedHooks }
    })

    await this.afterCommit(workspaceId, [
      ...result.previous.map((apiToken) => ({
        action: "delete" as const,
        detail: `connect link replaced: deleted workspace API token "${apiToken.id}"`,
      })),
      {
        action: "create",
        detail: `created workspace API token "${token.name}" (full, scopes: ${token.scopes.join(",")})`,
      },
    ])

    return {
      tokenId: result.created.id,
      replacedTokens: result.previous.length,
      removedHooks: result.removedHooks,
    }
  }

  /**
   * Ends the link the given token belongs to. Re-reads the token inside the
   * lock: if a reconnect already replaced it, this is a no-op and the new link
   * survives.
   */
  async endLink(props: {
    workspaceId: string
    tokenId: string
    client: ConnectLinkClient
  }) {
    const { workspaceId, tokenId, client } = props
    const result = await db.transaction(async (tx) => {
      await workspaceApiTokenRepository.lockWorkspaceTokens(workspaceId, tx)
      const current = (
        await workspaceApiTokenRepository.listByWorkspaceId(workspaceId, tx)
      ).find((apiToken) => apiToken.id === tokenId)
      if (!(current && client.isClientToken(current.name))) {
        return null
      }
      await workspaceApiTokenRepository.deleteByIdForWorkspace(
        { id: tokenId, workspaceId },
        tx,
      )
      const removedHooks = await this.removeHooks(
        workspaceId,
        client.hookEvents,
        tx,
      )
      return { removedHooks }
    })
    if (!result) {
      return null
    }
    await this.afterCommit(workspaceId, [
      {
        action: "delete",
        detail: `connect link ended: deleted workspace API token "${tokenId}"`,
      },
    ])
    return result
  }

  /**
   * Called before the upstream settings screen deletes a token: when it is the
   * client's link token, its lead hooks go too, so leads stop with the key.
   * The token itself is left for the caller to delete.
   */
  async removeHooksForToken(props: {
    workspaceId: string
    tokenId: string
    client: ConnectLinkClient
  }): Promise<number> {
    const { workspaceId, tokenId, client } = props
    return await db.transaction(async (tx) => {
      await workspaceApiTokenRepository.lockWorkspaceTokens(workspaceId, tx)
      const current = (
        await workspaceApiTokenRepository.listByWorkspaceId(workspaceId, tx)
      ).find((apiToken) => apiToken.id === tokenId)
      if (!(current && client.isClientToken(current.name))) {
        return 0
      }
      return await this.removeHooks(workspaceId, client.hookEvents, tx)
    })
  }
}

export const chatplusConnectLinkService = new ChatplusConnectLinkService()
