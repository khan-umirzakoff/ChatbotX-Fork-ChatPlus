import type * as Party from "partykit/server"
import { parseRealtimeEnv } from "../env"
import { getAuthSession } from "../lib/auth"
import { verifyBroadcastRequest } from "../lib/realtime-auth"

export default class WorkspaceParty implements Party.Server {
  // biome-ignore lint/style/noParameterProperties: wip
  constructor(readonly room: Party.Room) {}

  onConnect(
    connection: Party.Connection,
    { request }: Party.ConnectionContext,
  ) {
    const userId = request.headers.get("X-User-ID")
    if (!userId) {
      return connection.close(1008, "Unauthorized")
    }
  }

  async onRequest(req: Party.Request) {
    const payload = await req.json()
    this.room.broadcast(JSON.stringify(payload))

    return new Response("ok", { status: 200 })
  }

  static async onBeforeRequest(
    req: Party.Request,
    lobby: Party.Lobby,
    // ctx: Party.ExecutionContext
  ) {
    const env = parseRealtimeEnv(lobby.env)
    const error = await verifyBroadcastRequest(
      req,
      "workspace",
      env.REALTIME_BROADCAST_SECRET,
    )
    return error ?? req
  }

  static async onBeforeConnect(
    req: Party.Request,
    lobby: Party.Lobby,
    // ctx: Party.ExecutionContext
  ) {
    const env = parseRealtimeEnv(lobby.env)
    const session = await getAuthSession(req, env.BETTER_AUTH_URL)
    req.headers.set("X-User-ID", session.user.id)

    return req
  }
}
