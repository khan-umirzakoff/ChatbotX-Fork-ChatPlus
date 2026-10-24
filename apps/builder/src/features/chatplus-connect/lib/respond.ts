import "server-only"
import { NextResponse } from "next/server"
import type { EndpointResult } from "./token-endpoint"

const MAX_BODY_BYTES = 16 * 1024

/**
 * Reads an `application/x-www-form-urlencoded` body (RFC 6749 §3.2). The size
 * is counted while streaming, so an oversized unauthenticated body is dropped
 * before it is buffered.
 */
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
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return null
  }
  const reader = request.body?.getReader()
  if (!reader) {
    return new URLSearchParams()
  }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
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
