import { isWorkspaceScheduledForDeletion } from "@chatbotx.io/business"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { ConsentForm } from "@/features/chatplus-connect/components/consent-form"
import {
  authorizeRequestSchema,
  buildClientRedirect,
  singleValuedParams,
} from "@/features/chatplus-connect/lib/authorize-request"
import {
  findConnectClient,
  isAllowedRedirectUri,
} from "@/features/chatplus-connect/lib/clients"
import { issuerFromHeaders } from "@/features/chatplus-connect/lib/issuer"
import { getChatplusTranslations } from "@/features/chatplus-core/i18n"
import { hasWorkspacePermission } from "@/lib/auth/permission-routes"
import { enforcePasswordCurrent } from "@/lib/auth/require-password-current"
import { getCurrentUserAndAllLinkedWorkspaces } from "@/lib/auth/utils"

type ConnectPageProps = {
  params: Promise<{ client: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/** Consent screen of the ChatPLUS connect handshake (docs/chatplus-beecrm-connect.md). */
export default async function ConnectPage(props: ConnectPageProps) {
  const [{ client: clientId }, searchParams] = await Promise.all([
    props.params,
    props.searchParams,
  ])
  const t = await getChatplusTranslations("connect")

  const userAndWorkspaces = await getCurrentUserAndAllLinkedWorkspaces()
  if (!userAndWorkspaces) {
    return notFound()
  }
  enforcePasswordCurrent(userAndWorkspaces.user)

  const parsed = authorizeRequestSchema.safeParse(
    singleValuedParams(searchParams),
  )
  const client = findConnectClient(clientId)
  const issuer = issuerFromHeaders(await headers())
  // An unknown client or redirect URI never gets a redirect: it could be an open-redirect probe.
  if (
    !(
      parsed.success &&
      client &&
      parsed.data.client_id === client.clientId &&
      isAllowedRedirectUri(client, parsed.data.redirect_uri) &&
      issuer
    )
  ) {
    return (
      <ConnectCard
        description={t("invalidDescription", {
          client: client?.name ?? t("unknownClient"),
        })}
        title={t("invalidTitle")}
      />
    )
  }

  const request = parsed.data
  const workspaces = userAndWorkspaces.allWorkspaceMembers
    .filter(
      (member) =>
        hasWorkspacePermission(member.permissions, "superAdmin") &&
        !isWorkspaceScheduledForDeletion(member.workspace),
    )
    .map((member) => ({ id: member.workspace.id, name: member.workspace.name }))
  const denyUrl = buildClientRedirect(request.redirect_uri, {
    error: "access_denied",
    state: request.state,
    iss: issuer,
  })
  const team = request.beecrm_team_name ?? request.beecrm_team_id

  return (
    <ConnectCard
      description={t("description", { client: client.name, team })}
      title={t("title", { client: client.name })}
    >
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">
          {t("permissionsTitle", { client: client.name })}
        </p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>{t("permissionInbox")}</li>
          <li>{t("permissionContacts")}</li>
          <li>{t("permissionIntegrations", { client: client.name })}</li>
        </ul>
        <p className="text-muted-foreground">
          {t("replaceNote", { client: client.name })}
        </p>
        <p className="text-muted-foreground">
          {t("revokeNote", { client: client.name })}
        </p>
      </div>
      {workspaces.length === 0 ? (
        <p className="text-sm">{t("noWorkspaces")}</p>
      ) : (
        <ConsentForm
          denyUrl={denyUrl}
          labels={{
            workspace: t("workspaceLabel"),
            approve: t("approve"),
            deny: t("deny"),
            genericError: t("errorGeneric"),
          }}
          request={request}
          workspaces={workspaces}
        />
      )}
    </ConnectCard>
  )
}

function ConnectCard(props: {
  title: string
  description: string
  children?: React.ReactNode
}) {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{props.title}</CardTitle>
          <CardDescription>{props.description}</CardDescription>
        </CardHeader>
        {props.children && (
          <CardContent className="flex flex-col gap-6">
            {props.children}
          </CardContent>
        )}
      </Card>
    </main>
  )
}
