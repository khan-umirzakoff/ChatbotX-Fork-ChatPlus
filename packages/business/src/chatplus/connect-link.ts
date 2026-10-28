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
import { createId } from "@chatbotx.io/utils"
import { getAuditActor, withAuditContext } from "../audit/context"
import { BaseService } from "../base.service"
import { ChatbotXException } from "../errors"
import { logger } from "../logger"
import { assertPublicUrl } from "../net/ssrf-guard"
import {
  workspaceApiTokenCacheTag,
  workspaceApiTokenService,
} from "../workspace-api-token/service"

/**
 * A ChatPLUS connect link (CONNECT-001): one client token in a workspace plus
 * the client's lead hook. Every change runs in one transaction behind the
 * same per-workspace advisory lock as `createToken`, so replacing, ending and
 * settings deletion cannot interleave, and a failed step leaves the previous
 * state intact. The lead hook is registered here, inside that transaction,
 * never through the public external-webhooks API, so no stale request can
 * re-create a hook after the link ended.
 */
export type ConnectLinkClient = {
  /** Token names this client minted end with this marker. */
  isClientToken: (tokenName: string) => boolean
  /** External-webhook events of the client's lead hook. */
  hookEvents: string[]
  /**
   * `ExternalWebhook.provider` of the link's hook, e.g. `connect:beecrm`. Only
   * this service writes it (the public API accepts `make`/`n8n` only), so it
   * identifies the link's hook regardless of URL or later config changes.
   */
  hookProvider: string
}

type AuditEntry = { action: "create" | "delete"; detail: string }

const errorName = (err: unknown) => ({
  name: err instanceof Error ? err.name : typeof err,
})

class ChatplusConnectLinkService extends BaseService {
  private async removeHooks(
    workspaceId: string,
    client: ConnectLinkClient,
    tx: DatabaseClient,
  ): Promise<number> {
    if (client.hookEvents.length === 0) {
      return 0
    }
    const rows = await tx
      .delete(externalWebhookModel)
      .where(
        and(
          eq(externalWebhookModel.workspaceId, workspaceId),
          eq(externalWebhookModel.provider, client.hookProvider),
          inArray(externalWebhookModel.event, client.hookEvents),
        ),
      )
      .returning({ id: externalWebhookModel.id })
    return rows.length
  }

  /** Cache invalidation and audit run only after commit, so a rollback never leaves either behind. */
  private afterCommit(workspaceId: string, entries: AuditEntry[]) {
    // Audit records need the workspace; callers such as the client revoke only know it here.
    return withAuditContext({ ...(getAuditActor() ?? {}), workspaceId }, () =>
      this.recordAfterCommit(workspaceId, entries),
    )
  }

  private async recordAfterCommit(workspaceId: string, entries: AuditEntry[]) {
    try {
      await this.invalidateCacheTags(workspaceApiTokenCacheTag(workspaceId))
    } catch (err) {
      logger.warn(
        { err: errorName(err), workspaceId },
        "connect link: cache invalidation failed",
      )
    }
    for (const entry of entries) {
      try {
        await this.audit(entry.action, entry.detail)
      } catch (err) {
        logger.warn(
          { err: errorName(err), workspaceId },
          "connect link: audit record failed",
        )
      }
    }
  }

  /** Deletes the token and the client's hooks if the token still exists and is the client's. Caller holds the lock. */
  private async endInTx(
    workspaceId: string,
    tokenId: string,
    client: ConnectLinkClient,
    tx: DatabaseClient,
  ) {
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
    return {
      removedHooks: await this.removeHooks(workspaceId, client, tx),
    }
  }

  /**
   * Ends any earlier link of the client in the workspace, mints the new token
   * and, when given, registers the lead hook: all in one transaction.
   */
  async replaceLink(props: {
    workspaceId: string
    client: ConnectLinkClient
    token: {
      name: string
      tokenHash: TokenHash
      tokenPrefix: string
      scopes: WorkspaceApiTokenScope[]
    }
    leadHook?: { url: string; event: string }
  }) {
    const { workspaceId, client, token, leadHook } = props
    if (leadHook) {
      if (!client.hookEvents.includes(leadHook.event)) {
        throw new ChatbotXException(
          "Unknown lead hook event",
          "invalidRequestData",
          422,
        )
      }
      await assertPublicUrl(leadHook.url, "Lead hook URL")
    }

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
      const removedHooks = await this.removeHooks(workspaceId, client, tx)
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
      if (leadHook) {
        await tx.insert(externalWebhookModel).values({
          id: createId(),
          workspaceId,
          provider: client.hookProvider,
          event: leadHook.event,
          url: leadHook.url,
        })
      }
      return { created, previous, removedHooks }
    })

    await this.afterCommit(workspaceId, [
      ...result.previous.map((apiToken) => ({
        action: "delete" as const,
        detail: `connect link replaced: deleted workspace API token "${apiToken.id}"`,
      })),
      {
        action: "create",
        detail: `created workspace API token "${token.name}" (full, scopes: ${token.scopes.join(",")})${leadHook ? ` with its ${leadHook.event} lead hook` : ""}`,
      },
    ])

    return {
      tokenId: result.created.id,
      replacedTokens: result.previous.length,
      removedHooks: result.removedHooks,
      leadHookRegistered: Boolean(leadHook),
    }
  }

  /** Ends the link of a token by id (settings deletion). Null when it is not the client's live token. */
  async endLink(props: {
    workspaceId: string
    tokenId: string
    client: ConnectLinkClient
  }) {
    const { workspaceId, tokenId, client } = props
    // Unlocked pre-check, so deleting an unrelated token never waits on or fails in this transaction.
    const candidate = (
      await workspaceApiTokenRepository.listByWorkspaceId(workspaceId)
    ).find((apiToken) => apiToken.id === tokenId)
    if (!(candidate && client.isClientToken(candidate.name))) {
      return null
    }
    const result = await db.transaction(async (tx) => {
      await workspaceApiTokenRepository.lockWorkspaceTokens(workspaceId, tx)
      return await this.endInTx(workspaceId, tokenId, client, tx)
    })
    if (result) {
      await this.afterCommit(workspaceId, [
        {
          action: "delete",
          detail: `connect link ended: deleted workspace API token "${tokenId}"`,
        },
      ])
    }
    return result
  }

  /**
   * Ends the link of a presented token (client revoke). Reads the token
   * uncached and re-checks it inside the lock: a token a reconnect already
   * replaced is a no-op, so the new link survives.
   */
  async endLinkByTokenHash(props: {
    tokenHash: TokenHash
    client: ConnectLinkClient
  }) {
    const { tokenHash, client } = props
    const found = await workspaceApiTokenRepository.findByTokenHash(tokenHash)
    if (!(found && client.isClientToken(found.name))) {
      return null
    }
    const { workspaceId } = found
    const result = await db.transaction(async (tx) => {
      await workspaceApiTokenRepository.lockWorkspaceTokens(workspaceId, tx)
      return await this.endInTx(workspaceId, found.id, client, tx)
    })
    if (!result) {
      return null
    }
    await this.afterCommit(workspaceId, [
      {
        action: "delete",
        detail: `connect link revoked: deleted workspace API token "${found.id}"`,
      },
    ])
    return { workspaceId, tokenId: found.id, ...result }
  }
}

export const chatplusConnectLinkService = new ChatplusConnectLinkService()
