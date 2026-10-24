// @vitest-environment node
import { createHash } from "node:crypto"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    redis: {
      set: vi.fn((key: string, value: string, ..._args: unknown[]) => {
        if (store.has(key)) {
          return Promise.resolve(null)
        }
        store.set(key, value)
        return Promise.resolve("OK")
      }),
      getdel: vi.fn((key: string) => {
        const value = store.get(key) ?? null
        store.delete(key)
        return Promise.resolve(value)
      }),
      incr: vi.fn((key: string) => {
        const next = Number(store.get(key) ?? 0) + 1
        store.set(key, String(next))
        return Promise.resolve(next)
      }),
      expire: vi.fn(async () => 1),
    },
    createToken: vi.fn(),
    deleteToken: vi.fn(),
    findWorkspaceByTokenHash: vi.fn(),
    listTokens: vi.fn(),
    findById: vi.fn(),
    isScheduled: vi.fn(() => false),
    listHooks: vi.fn(),
    unregisterHook: vi.fn(),
  }
})

vi.mock("server-only", () => ({}))
vi.mock("@chatbotx.io/redis", () => ({
  cacheConnections: { useExisting: () => Promise.resolve(mocks.redis) },
  distributedLock: {
    runExclusive: ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  },
}))
vi.mock("@chatbotx.io/auth/tenant", () => ({
  resolveTenantByDomain: (domain: string) =>
    Promise.resolve(domain === "reseller.test" ? "77" : "1"),
}))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: (headers: Headers) =>
    headers.get("x-forwarded-for") ?? "unknown",
}))
vi.mock("@chatbotx.io/business", () => ({
  workspaceApiTokenService: {
    createToken: mocks.createToken,
    deleteToken: mocks.deleteToken,
    findWorkspaceByTokenHash: mocks.findWorkspaceByTokenHash,
    listTokens: mocks.listTokens,
  },
  workspaceService: { findById: mocks.findById },
  isWorkspaceScheduledForDeletion: mocks.isScheduled,
  externalWebhookService: {
    listByWorkspaceAndEvents: mocks.listHooks,
    unregister: mocks.unregisterHook,
  },
}))
vi.mock("@/lib/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { authenticateClient, listConnectClients } = await import(
  "../src/features/chatplus-connect/lib/clients"
)
const { issueConnectCode, verifyPkce } = await import(
  "../src/features/chatplus-connect/lib/code-store"
)
const { exchangeConnectCode, revokeConnectToken, CONNECT_TOKEN_SCOPES } =
  await import("../src/features/chatplus-connect/lib/token-endpoint")
const { authorizeRequestSchema, buildClientRedirect, singleValuedParams } =
  await import("../src/features/chatplus-connect/lib/authorize-request")
const { issuerFromHeaders } = await import(
  "../src/features/chatplus-connect/lib/issuer"
)
const { readForm } = await import(
  "../src/features/chatplus-connect/lib/respond"
)

const ISSUER = "https://app.chatplus.test"
const REDIRECT =
  "https://api.beecrm.test/api/integrations/chatplus/connect/callback/"
const SECRET = "s3cret-value"
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex")
const VERIFIER = "v".repeat(64)
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url")
const WORKSPACE_TOKEN_PATTERN = /^cbx_ws_/
const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`

const record = {
  issuer: ISSUER,
  tenantId: "1",
  clientId: "beecrm",
  redirectUri: REDIRECT,
  codeChallenge: CHALLENGE,
  workspaceId: "ws-1",
  userId: "u-1",
  beecrmTeamId: "team-7",
  beecrmUserId: "user-9",
  beecrmTeamName: "DiziPro",
}

const exchange = (
  code: string,
  overrides: Record<string, string> = {},
  auth = basic("beecrm", SECRET),
  issuer = ISSUER,
  ip = "10.0.0.1",
) =>
  exchangeConnectCode({
    headers: new Headers({ authorization: auth, "x-forwarded-for": ip }),
    issuer,
    form: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      ...overrides,
    }),
  })

beforeEach(() => {
  mocks.store.clear()
  vi.clearAllMocks()
  vi.stubEnv(
    "CHATPLUS_CONNECT_CLIENTS",
    JSON.stringify([
      {
        clientId: "beecrm",
        name: "BeeCRM",
        secretSha256: [sha256(SECRET)],
        redirectUris: [REDIRECT],
      },
    ]),
  )
  mocks.findById.mockResolvedValue({
    id: "ws-1",
    name: "Gulnoza Kids",
    tenantId: "1",
  })
  mocks.createToken.mockResolvedValue({ id: "tok-1" })
  mocks.listHooks.mockResolvedValue([{ id: "hook-1" }])
  mocks.listTokens.mockResolvedValue([])
})

describe("connect clients", () => {
  test("a malformed config disables every client", () => {
    vi.stubEnv("CHATPLUS_CONNECT_CLIENTS", "{not json")
    expect(listConnectClients()).toEqual([])
  })

  test("a non-https redirect URI is rejected", () => {
    vi.stubEnv(
      "CHATPLUS_CONNECT_CLIENTS",
      JSON.stringify([
        {
          clientId: "beecrm",
          name: "BeeCRM",
          secretSha256: [sha256(SECRET)],
          redirectUris: ["http://api.beecrm.test/cb"],
        },
      ]),
    )
    expect(listConnectClients()).toEqual([])
  })

  test("Basic auth accepts the right secret only", async () => {
    expect((await authenticateClient(basic("beecrm", SECRET)))?.clientId).toBe(
      "beecrm",
    )
    expect(await authenticateClient(basic("beecrm", "wrong"))).toBeUndefined()
    expect(await authenticateClient(basic("other", SECRET))).toBeUndefined()
    expect(await authenticateClient("Bearer abc")).toBeUndefined()
    expect(await authenticateClient(basic("%E0%A4%A", SECRET))).toBeUndefined()
    expect(await authenticateClient(null)).toBeUndefined()
  })
})

describe("authorize request", () => {
  const query = {
    response_type: "code",
    client_id: "beecrm",
    redirect_uri: REDIRECT,
    state: "s".repeat(32),
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    beecrm_team_id: "team-7",
    beecrm_user_id: "user-9",
  }

  test("accepts a PKCE S256 request and rejects plain", () => {
    expect(authorizeRequestSchema.safeParse(query).success).toBe(true)
    expect(
      authorizeRequestSchema.safeParse({
        ...query,
        code_challenge_method: "plain",
      }).success,
    ).toBe(false)
  })

  test("a repeated query key is dropped, so the request fails validation", () => {
    const params = singleValuedParams({ ...query, state: ["a", "b"] })
    expect(authorizeRequestSchema.safeParse(params).success).toBe(false)
  })

  test("the redirect carries code, state and iss", () => {
    const url = new URL(
      buildClientRedirect(REDIRECT, { code: "c", state: "st", iss: ISSUER }),
    )
    expect(url.origin + url.pathname).toBe(REDIRECT)
    expect(url.searchParams.get("iss")).toBe(ISSUER)
    expect(url.searchParams.get("state")).toBe("st")
  })
})

describe("PKCE", () => {
  test("S256 verifier matches its challenge only", () => {
    expect(verifyPkce(VERIFIER, CHALLENGE)).toBe(true)
    expect(verifyPkce("w".repeat(64), CHALLENGE)).toBe(false)
    expect(verifyPkce("short", CHALLENGE)).toBe(false)
  })
})

describe("token endpoint", () => {
  test("a valid exchange mints a scoped token bound to the BeeCRM team and user", async () => {
    const code = await issueConnectCode(record)
    const result = await exchange(code)

    expect(result.status).toBe(200)
    expect(mocks.createToken).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        name: "BeeCRM · DiziPro #beecrm",
        permission: "full",
        scopes: CONNECT_TOKEN_SCOPES,
      }),
    )
    expect(result.body).toMatchObject({
      token_type: "Bearer",
      token_id: "tok-1",
      scopes: ["inbox", "contacts", "integrations"],
      workspace: { id: "ws-1", name: "Gulnoza Kids" },
      api_base: `${ISSUER}/api`,
      beecrm_team_id: "team-7",
      beecrm_user_id: "user-9",
    })
    expect(String(result.body.access_token)).toMatch(WORKSPACE_TOKEN_PATTERN)
  })

  test("a new link replaces the earlier BeeCRM link and its lead hook", async () => {
    mocks.listTokens.mockResolvedValue([
      { id: "tok-old", name: "BeeCRM · Old team #beecrm" },
      { id: "tok-own", name: "My own key" },
      { id: "tok-look-alike", name: "BeeCRM · not minted" },
    ])
    const code = await issueConnectCode(record)
    expect((await exchange(code)).status).toBe(200)
    expect(mocks.deleteToken).toHaveBeenCalledTimes(1)
    expect(mocks.deleteToken).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "tok-old",
    })
    expect(mocks.unregisterHook).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "hook-1",
    })
  })

  test("a code works once", async () => {
    const code = await issueConnectCode(record)
    expect((await exchange(code)).status).toBe(200)
    expect((await exchange(code)).body.error).toBe("invalid_grant")
    expect(mocks.createToken).toHaveBeenCalledTimes(1)
  })

  test.each([
    ["wrong verifier", { code_verifier: "w".repeat(64) }, ISSUER],
    ["wrong redirect", { redirect_uri: `${REDIRECT}x` }, ISSUER],
    ["other issuer", {}, "https://evil.test"],
  ])("%s → invalid_grant and the code is burned", async (_, overrides, issuer) => {
    const code = await issueConnectCode(record)
    const failed = await exchange(code, overrides, undefined, issuer)
    expect(failed.body.error).toBe("invalid_grant")
    expect((await exchange(code)).body.error).toBe("invalid_grant")
    expect(mocks.createToken).not.toHaveBeenCalled()
  })

  test("a bad client secret is 401 and does not consume the code", async () => {
    const code = await issueConnectCode(record)
    const result = await exchange(code, {}, basic("beecrm", "nope"))
    expect(result.status).toBe(401)
    expect(result.headers?.["WWW-Authenticate"]).toContain("Basic")
    expect((await exchange(code)).status).toBe(200)
  })

  test("another grant type is refused", async () => {
    const code = await issueConnectCode(record)
    const result = await exchange(code, { grant_type: "client_credentials" })
    expect(result.body.error).toBe("unsupported_grant_type")
  })

  test("a workspace scheduled for deletion gets no token", async () => {
    mocks.isScheduled.mockReturnValueOnce(true)
    const code = await issueConnectCode(record)
    expect((await exchange(code)).body.error).toBe("invalid_grant")
    expect(mocks.createToken).not.toHaveBeenCalled()
  })

  test("a code issued on another tenant's host is refused", async () => {
    const code = await issueConnectCode({ ...record, tenantId: "77" })
    expect((await exchange(code)).body.error).toBe("invalid_grant")
  })

  test("a workspace of another tenant is refused", async () => {
    mocks.findById.mockResolvedValueOnce({
      id: "ws-1",
      name: "x",
      tenantId: "77",
    })
    const code = await issueConnectCode(record)
    expect((await exchange(code)).body.error).toBe("invalid_grant")
    expect(mocks.createToken).not.toHaveBeenCalled()
  })

  test("unauthenticated attempts are limited per IP before the secret is checked", async () => {
    for (let i = 0; i < 60; i++) {
      await exchange(
        "x".repeat(43),
        {},
        basic("beecrm", "wrong"),
        ISSUER,
        "6.6.6.6",
      )
    }
    const limited = await exchange(
      "x".repeat(43),
      {},
      basic("beecrm", SECRET),
      ISSUER,
      "6.6.6.6",
    )
    expect(limited.status).toBe(429)
    expect((await exchange("x".repeat(43))).status).toBe(400)
  })

  test("the token cap becomes invalid_request", async () => {
    mocks.createToken.mockRejectedValueOnce(new Error("limit"))
    const code = await issueConnectCode(record)
    const result = await exchange(code)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe("invalid_request")
  })

  test("more than 60 calls a minute per client are throttled", async () => {
    for (let i = 0; i < 60; i++) {
      await exchange("x".repeat(43), {}, undefined, ISSUER, `10.1.0.${i}`)
    }
    const result = await exchange("x".repeat(43))
    expect(result.status).toBe(429)
  })
})

describe("revoke endpoint", () => {
  const revoke = (token: string, auth = basic("beecrm", SECRET)) =>
    revokeConnectToken({
      headers: new Headers({ authorization: auth }),
      form: new URLSearchParams({ token }),
    })

  test("revokes a handshake token and removes the BeeCRM hooks", async () => {
    mocks.findWorkspaceByTokenHash.mockResolvedValue({
      workspace: { id: "ws-1" },
      apiToken: { id: "tok-1", name: "BeeCRM · DiziPro #beecrm" },
    })
    mocks.listTokens.mockResolvedValue([
      { id: "tok-1", name: "BeeCRM · DiziPro #beecrm" },
    ])
    const result = await revoke("cbx_ws_abc")
    expect(result.status).toBe(200)
    expect(mocks.deleteToken).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "tok-1",
    })
    expect(mocks.listHooks).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      events: ["beecrm"],
    })
    expect(mocks.unregisterHook).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "hook-1",
    })
  })

  test("leaves tokens the client did not mint alone", async () => {
    mocks.findWorkspaceByTokenHash.mockResolvedValue({
      workspace: { id: "ws-1" },
      apiToken: { id: "tok-2", name: "BeeCRM · look-alike" },
    })
    expect((await revoke("cbx_ws_abc")).status).toBe(200)
    expect(mocks.deleteToken).not.toHaveBeenCalled()
  })

  test("an unknown token still answers 200", async () => {
    mocks.findWorkspaceByTokenHash.mockResolvedValue(undefined)
    expect((await revoke("cbx_ws_unknown")).status).toBe(200)
    expect(mocks.deleteToken).not.toHaveBeenCalled()
  })

  test("needs client authentication", async () => {
    expect((await revoke("cbx_ws_abc", basic("beecrm", "nope"))).status).toBe(
      401,
    )
  })
})

describe("request plumbing", () => {
  test("the issuer is the origin of the proxy-set x-url header", () => {
    expect(
      issuerFromHeaders(
        new Headers({
          "x-url": "https://app.chatplus.test/cp/connect/beecrm?x=1",
        }),
      ),
    ).toBe("https://app.chatplus.test")
    expect(issuerFromHeaders(new Headers())).toBe("")
    expect(issuerFromHeaders(new Headers({ "x-url": "not a url" }))).toBe("")
  })

  const formRequest = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://app.chatplus.test/api/chatplus/connect/token", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
    })

  test("reads a small form body", async () => {
    const form = await readForm(formRequest("grant_type=authorization_code"))
    expect(form?.get("grant_type")).toBe("authorization_code")
  })

  test("rejects a body over 16 KiB and a JSON body", async () => {
    expect(await readForm(formRequest(`a=${"x".repeat(17 * 1024)}`))).toBeNull()
    expect(
      await readForm(formRequest("{}", { "content-type": "application/json" })),
    ).toBeNull()
  })
})
