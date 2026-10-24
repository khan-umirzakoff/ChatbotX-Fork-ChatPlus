import { getPublicOriginFromRequest } from "@chatbotx.io/utils"
import { readForm, toResponse } from "@/features/chatplus-connect/lib/respond"
import { exchangeConnectCode } from "@/features/chatplus-connect/lib/token-endpoint"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const form = await readForm(request)
  if (!form) {
    return toResponse({ status: 400, body: { error: "invalid_request" } })
  }
  return toResponse(
    await exchangeConnectCode({
      authorization: request.headers.get("authorization"),
      form,
      issuer: getPublicOriginFromRequest(request),
    }),
  )
}
