import { z } from "zod"

const realtimeEnvSchema = z.object({
  REALTIME_BROADCAST_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
})

export const parseRealtimeEnv = (runtimeEnv: Record<string, unknown>) =>
  realtimeEnvSchema.parse(runtimeEnv)
