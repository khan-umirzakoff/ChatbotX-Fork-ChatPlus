import "server-only"
import { NextResponse } from "next/server"
import type { EndpointResult } from "./token-endpoint"

const MAX_BODY_BYTES = 16 * 1024

/** Reads an `application/x-www-form-urlencoded` body (RFC 6749 §3.2), capped at 16 KiB. */
export async function readForm(
  request: Request,
): Promise<URLSearchParams | null> {
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  ) {
    return null
  }
  const body = await request.text()
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return null
  }
  return new URLSearchParams(body)
}

/** Token responses must never be cached (RFC 6749 §5.1). */
export function toResponse(result: EndpointResult): NextResponse {
  return NextResponse.json(result.body, {
    status: result.status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...result.headers,
    },
  })
}
