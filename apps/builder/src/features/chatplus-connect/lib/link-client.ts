import "server-only"
import {
  type ConnectLinkClient,
  chatplusConnectLinkService,
} from "@chatbotx.io/business"
import { logger } from "@/lib/log"

/** External-webhook events of each client's lead hook (CHATPLUS-BEECRM-001: `beecrm`). */
const CLIENT_HOOK_EVENTS: Record<string, string[]> = { beecrm: ["beecrm"] }

/** The event the lead hook registered at connect time listens to. */
export const leadHookEvent = (clientId: string) =>
  CLIENT_HOOK_EVENTS[clientId]?.[0]

/**
 * Tokens minted for a client end with ` #<clientId>`: the immutable id, not the
 * display name, so renaming the client in config never orphans its tokens.
 * shortcut: ownership is read from the token name because the fork adds no
 * tables; a workspace admin who names a token the same way would have it
 * replaced on reconnect. Upgrade to an owner column on the token (upstream PR)
 * when one exists.
 */
export const ownershipSuffix = (clientId: string) => ` #${clientId}`

export function linkClient(clientId: string): ConnectLinkClient {
  const suffix = ownershipSuffix(clientId)
  return {
    isClientToken: (tokenName) => tokenName.endsWith(suffix),
    hookEvents: CLIENT_HOOK_EVENTS[clientId] ?? [],
    hookProvider: `connect:${clientId}`,
  }
}

/**
 * Registration point for the upstream "delete API token" settings action: a
 * client's link token is deleted together with its lead hook in one locked
 * transaction. Returns true when it did so; for any other token it returns
 * false and the upstream deletion runs as before.
 */
export async function endConnectLinkForToken(props: {
  workspaceId: string
  tokenId: string
}): Promise<boolean> {
  for (const clientId of Object.keys(CLIENT_HOOK_EVENTS)) {
    const ended = await chatplusConnectLinkService.endLink({
      ...props,
      client: linkClient(clientId),
    })
    if (ended) {
      logger.info(
        { ...props, clientId, removedHooks: ended.removedHooks },
        "ChatPLUS connect: link ended from settings",
      )
      return true
    }
  }
  return false
}
