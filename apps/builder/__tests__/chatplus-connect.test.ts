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
    replaceLink: vi.fn(),
    endLink: vi.fn(),
    endLinkByTokenHash: vi.fn(),
    findById: vi.fn(),
    isScheduled: vi.fn(() => false),
    logWarn: vi.fn(),
  }
})

vi.mock("server-only", () => ({}))
vi.mock("@chatbotx.io/redis", () => ({
  cacheConnections: { useExisting: () => Promise.resolve(mocks.redis) },
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
  CONNECT_LEAD_HOOK_CONFLICT: "connectLeadHookConflict",
  chatplusConnectLinkService: {
    replaceLink: mocks.replaceLink,
    endLink: mocks.endLink,
    endLinkByTokenHash: mocks.endLinkByTokenHash,
  },
  workspaceService: { findById: mocks.findById },
  isWorkspaceScheduledForDeletion: mocks.isScheduled,
}))
vi.mock("@/lib/log", () => ({
  logger: { info: vi.fn(), warn: mocks.logWarn, error: vi.fn() },
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
const { linkClient, endConnectLinkForToken } = await import(
  "../src/features/chatplus-connect/lib/link-client"
)

const ISSUER = "https://app.chatplus.test"
const REDIRECT =
  "https://api.beecrm.test/api/integrations/chatplus/connect/callback/"
const SECRET = "s3cret-value"
const HOOK_PREFIX = "https://api.beecrm.test/api/integrations/v1/chatplus/"
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
        leadHookUrlPrefixes: [HOOK_PREFIX],
      },
    ]),
  )
  mocks.findById.mockResolvedValue({
    id: "ws-1",
    name: "Gulnoza Kids",
    tenantId: "1",
  })
  mocks.replaceLink.mockResolvedValue({
    tokenId: "tok-1",
    replacedTokens: 0,
    removedHooks: 0,
    leadHookRegistered: false,
  })
  mocks.endLink.mockResolvedValue(null)
  mocks.endLinkByTokenHash.mockResolvedValue({
    workspaceId: "ws-1",
    tokenId: "tok-1",
    removedHooks: 1,
  })
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
    expect(mocks.replaceLink).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        token: expect.objectContaining({
          name: "BeeCRM · DiziPro #beecrm",
          scopes: CONNECT_TOKEN_SCOPES,
        }),
      }),
    )
    expect(result.body).toMatchObject({
      token_type: "Bearer",
      token_id: "tok-1",
      scopes: ["inbox", "contacts"],
      lead_hook_registered: false,
      workspace: { id: "ws-1", name: "Gulnoza Kids" },
      api_base: `${ISSUER}/api`,
      beecrm_team_id: "team-7",
      beecrm_user_id: "user-9",
    })
    expect(String(result.body.access_token)).toMatch(WORKSPACE_TOKEN_PATTERN)
  })

  test("the link client recognises only tokens minted with its id", () => {
    const client = linkClient("beecrm")
    expect(client.isClientToken("BeeCRM · Old team #beecrm")).toBe(true)
    expect(client.isClientToken("BeeCRM · not minted")).toBe(false)
    expect(client.isClientToken("My own key")).toBe(false)
    expect(client.hookEvents).toEqual(["beecrm"])
    expect(client.hookProvider).toBe("connect:beecrm")
  })

  test("registers an allowed lead hook inside the exchange", async () => {
    mocks.replaceLink.mockResolvedValueOnce({
      tokenId: "tok-1",
      replacedTokens: 0,
      removedHooks: 0,
      leadHookRegistered: true,
    })
    const code = await issueConnectCode(record)
    const result = await exchange(code, {
      lead_hook_url: `${HOOK_PREFIX}s3cret/`,
    })
    expect(result.status).toBe(200)
    expect(result.body.lead_hook_registered).toBe(true)
    expect(mocks.replaceLink).toHaveBeenCalledWith(
      expect.objectContaining({
        leadHook: {
          url: `${HOOK_PREFIX}s3cret/`,
          event: "beecrm",
        },
      }),
    )
  })

  test.each([
    ["another host", "https://evil.test/api/integrations/v1/chatplus/x/"],
    [
      "a host extension",
      "https://api.beecrm.test.evil.test/api/integrations/v1/chatplus/x",
    ],
    [
      "userinfo",
      "https://user:pw@api.beecrm.test/api/integrations/v1/chatplus/x",
    ],
    ["a dot-segment escape", `${HOOK_PREFIX}%2e%2e/other`],
    ["an encoded slash", `${HOOK_PREFIX}a%2Fb`],
    ["a backslash", `${HOOK_PREFIX}a\\b`],
    [
      "an upper-case host",
      "https://API.beecrm.test/api/integrations/v1/chatplus/x",
    ],
    ["a query", `${HOOK_PREFIX}x?y=1`],
  ])("refuses a lead hook URL with %s and keeps the code", async (_, url) => {
    const code = await issueConnectCode(record)
    const refused = await exchange(code, { lead_hook_url: url })
    expect(refused.body.error).toBe("invalid_request")
    expect((await exchange(code)).status).toBe(200)
  })

  test("a lead hook URL taken by another integration gets an actionable error", async () => {
    mocks.replaceLink.mockRejectedValueOnce(
      Object.assign(new Error("taken"), { code: "connectLeadHookConflict" }),
    )
    const code = await issueConnectCode(record)
    const result = await exchange(code, {
      lead_hook_url: `${HOOK_PREFIX}s3cret/`,
    })
    expect(result.body.error).toBe("invalid_request")
    expect(String(result.body.error_description)).toContain(
      "already registered",
    )
  })

  test("a code works once", async () => {
    const code = await issueConnectCode(record)
    expect((await exchange(code)).status).toBe(200)
    expect((await exchange(code)).body.error).toBe("invalid_grant")
    expect(mocks.replaceLink).toHaveBeenCalledTimes(1)
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
    expect(mocks.replaceLink).not.toHaveBeenCalled()
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
    expect(mocks.replaceLink).not.toHaveBeenCalled()
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
    expect(mocks.replaceLink).not.toHaveBeenCalled()
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

  test("a failed mint becomes invalid_request and logs no error text", async () => {
    mocks.replaceLink.mockRejectedValueOnce(
      Object.assign(new Error("insert failed, params: $1=abc123hash"), {
        code: "23505",
      }),
    )
    const code = await issueConnectCode(record)
    const result = await exchange(code)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe("invalid_request")
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain("abc123hash")
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

  test("ends the link of the presented token", async () => {
    const result = await revoke("cbx_ws_abc")
    expect(result.status).toBe(200)
    expect(mocks.endLinkByTokenHash).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: sha256("cbx_ws_abc") }),
    )
  })

  test("a replaced, foreign or unknown token is a silent no-op", async () => {
    mocks.endLinkByTokenHash.mockResolvedValueOnce(null)
    expect((await revoke("cbx_ws_unknown")).status).toBe(200)
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

describe("settings token deletion", () => {
  test("a client link token is deleted together with its hook", async () => {
    mocks.endLink.mockResolvedValueOnce({ removedHooks: 1 })
    expect(
      await endConnectLinkForToken({ workspaceId: "ws-1", tokenId: "tok-1" }),
    ).toBe(true)
    expect(mocks.endLink).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", tokenId: "tok-1" }),
    )
  })

  test("any other token is left to the normal deletion", async () => {
    expect(
      await endConnectLinkForToken({ workspaceId: "ws-1", tokenId: "own" }),
    ).toBe(false)
  })
})
