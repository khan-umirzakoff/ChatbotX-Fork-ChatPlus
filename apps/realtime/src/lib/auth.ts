import ky from "ky"
import type * as Party from "partykit/server"
import { logger } from "../logger"

export type Session = {
  user: {
    name: string | null
    email: string | null
    id: string
  }
  session: {
    expiresAt: string
  }
}

/** Check that the user exists, and isn't expired */
export const isSessionValid = (session?: Session | null): boolean =>
  Boolean(
    session &&
      (!session.session.expiresAt ||
        session.session.expiresAt > new Date().toISOString()),
  )

export const getAuthSession = async (
  proxiedRequest: Party.Request,
  betterAuthUrl: string,
): Promise<Session> => {
  const url = new URL(proxiedRequest.url)
  const token = url.searchParams.get("token")
  if (!token) {
    throw new Error("No token provided")
  }

  const verificationUrl = new URL(
    "/api/auth/one-time-token/verify",
    betterAuthUrl,
  ).toString()

  try {
    const session = await ky
      .post(verificationUrl, {
        json: {
          token,
        },
      })
      .json<Session | null>()

    if (session && isSessionValid(session)) {
      return session
    }
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Realtime auth verification failed",
    )
    throw new Error("Failed to authenticate user")
  }

  throw new Error("Failed to authenticate user")
}
