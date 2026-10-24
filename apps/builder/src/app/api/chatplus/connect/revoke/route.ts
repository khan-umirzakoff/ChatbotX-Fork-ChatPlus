import { readForm, toResponse } from "@/features/chatplus-connect/lib/respond"
import { revokeConnectToken } from "@/features/chatplus-connect/lib/token-endpoint"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const form = await readForm(request)
  if (!form) {
    return toResponse({ status: 400, body: { error: "invalid_request" } })
  }
  return toResponse(
    await revokeConnectToken({
      headers: request.headers,
      form,
    }),
  )
}
