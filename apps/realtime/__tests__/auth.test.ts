import { beforeEach, describe, expect, test, vi } from "vitest"

const { jsonMock, postMock } = vi.hoisted(() => ({
  jsonMock: vi.fn(),
  postMock: vi.fn(),
}))

vi.mock("ky", () => ({
  default: {
    post: postMock,
  },
}))

const { getAuthSession } = await import("../src/lib/auth")

describe("getAuthSession", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    postMock.mockReturnValue({ json: jsonMock })
    jsonMock.mockResolvedValue({
      user: { id: "user-1", name: "User", email: "user@example.com" },
      session: { expiresAt: "2999-01-01T00:00:00.000Z" },
    })
  })

  test("verifies one-time tokens against the configured auth origin", async () => {
    const request = new Request(
      "https://realtime.chatplus.uz/parties/workspaces/room?token=one-time-secret",
      { headers: { origin: "https://attacker.example" } },
    )

    await expect(
      getAuthSession(request, "https://app.chatplus.uz"),
    ).resolves.toMatchObject({ user: { id: "user-1" } })
    expect(postMock).toHaveBeenCalledWith(
      "https://app.chatplus.uz/api/auth/one-time-token/verify",
      { json: { token: "one-time-secret" } },
    )
  })

  test("rejects requests without a one-time token before calling auth", async () => {
    const request = new Request(
      "https://realtime.chatplus.uz/parties/workspaces/room",
    )

    await expect(
      getAuthSession(request, "https://app.chatplus.uz"),
    ).rejects.toThrow("No token provided")
    expect(postMock).not.toHaveBeenCalled()
  })
})
