// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lock: vi.fn(),
  list: vi.fn(),
  deleteToken: vi.fn(),
  createToken: vi.fn(),
  deleteHooks: vi.fn(),
  invalidate: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => ({
  db: { transaction: mocks.transaction },
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  externalWebhookModel: {
    id: "id",
    workspaceId: "workspaceId",
    event: "event",
  },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  workspaceApiTokenRepository: {
    lockWorkspaceTokens: mocks.lock,
    listByWorkspaceId: mocks.list,
    deleteByIdForWorkspace: mocks.deleteToken,
  },
}))
vi.mock("@chatbotx.io/redis", () => ({
  invalidateCacheByTags: mocks.invalidate,
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecord: mocks.audit,
}))
vi.mock("../src/logger", () => ({ logger: { warn: vi.fn() } }))
vi.mock("../src/workspace-api-token/service", () => ({
  workspaceApiTokenCacheTag: (id: string) => `tokens:${id}`,
  workspaceApiTokenService: { createToken: mocks.createToken },
}))

const { chatplusConnectLinkService } = await import("../src/chatplus")

const client = {
  isClientToken: (name: string) => name.endsWith(" #beecrm"),
  hookEvents: ["beecrm"],
}
const tx = {
  delete: () => ({
    where: () => ({ returning: () => mocks.deleteHooks() }),
  }),
}
const token = {
  name: "BeeCRM · DiziPro #beecrm",
  tokenHash: "hash" as never,
  tokenPrefix: "cbx_ws_abc",
  scopes: ["inbox" as const],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.transaction.mockImplementation(
    async (fn: (t: unknown) => unknown) => await fn(tx),
  )
  mocks.list.mockResolvedValue([
    { id: "old", name: "BeeCRM · Old #beecrm" },
    { id: "own", name: "My key" },
  ])
  mocks.deleteHooks.mockResolvedValue([{ id: "hook-1" }])
  mocks.createToken.mockResolvedValue({ id: "new" })
})

describe("replaceLink", () => {
  test("ends the earlier link and mints the new token in one locked transaction", async () => {
    const result = await chatplusConnectLinkService.replaceLink({
      workspaceId: "ws-1",
      client,
      token,
    })

    expect(mocks.lock).toHaveBeenCalledWith("ws-1", tx)
    expect(mocks.deleteToken).toHaveBeenCalledTimes(1)
    expect(mocks.deleteToken).toHaveBeenCalledWith(
      { id: "old", workspaceId: "ws-1" },
      tx,
    )
    expect(mocks.createToken).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", permission: "full", tx }),
    )
    expect(result).toEqual({
      tokenId: "new",
      replacedTokens: 1,
      removedHooks: 1,
    })
    expect(mocks.invalidate).toHaveBeenCalledWith(["tokens:ws-1"])
    expect(mocks.audit).toHaveBeenCalledTimes(2)
  })

  test("a failed mint propagates and runs no post-commit side effects", async () => {
    mocks.createToken.mockRejectedValueOnce(new Error("cap"))
    await expect(
      chatplusConnectLinkService.replaceLink({
        workspaceId: "ws-1",
        client,
        token,
      }),
    ).rejects.toThrow("cap")
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})

describe("endLink", () => {
  test("is a no-op when the token was already replaced", async () => {
    const result = await chatplusConnectLinkService.endLink({
      workspaceId: "ws-1",
      tokenId: "gone",
      client,
    })
    expect(result).toBeNull()
    expect(mocks.deleteToken).not.toHaveBeenCalled()
    expect(mocks.deleteHooks).not.toHaveBeenCalled()
  })

  test("refuses a token the client did not mint", async () => {
    const result = await chatplusConnectLinkService.endLink({
      workspaceId: "ws-1",
      tokenId: "own",
      client,
    })
    expect(result).toBeNull()
    expect(mocks.deleteToken).not.toHaveBeenCalled()
  })

  test("deletes the current link token and its hooks", async () => {
    const result = await chatplusConnectLinkService.endLink({
      workspaceId: "ws-1",
      tokenId: "old",
      client,
    })
    expect(result).toEqual({ removedHooks: 1 })
    expect(mocks.deleteToken).toHaveBeenCalledWith(
      { id: "old", workspaceId: "ws-1" },
      tx,
    )
  })
})

describe("removeHooksForToken", () => {
  test("removes the hooks only for a client token", async () => {
    expect(
      await chatplusConnectLinkService.removeHooksForToken({
        workspaceId: "ws-1",
        tokenId: "old",
        client,
      }),
    ).toBe(1)
    expect(
      await chatplusConnectLinkService.removeHooksForToken({
        workspaceId: "ws-1",
        tokenId: "own",
        client,
      }),
    ).toBe(0)
    expect(mocks.deleteHooks).toHaveBeenCalledTimes(1)
    expect(mocks.deleteToken).not.toHaveBeenCalled()
  })
})
