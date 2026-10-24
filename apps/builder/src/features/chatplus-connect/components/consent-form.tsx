"use client"

import { Button, buttonVariants } from "@chatbotx.io/ui/components/ui/button"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import {
  RadioGroup,
  RadioGroupItem,
} from "@chatbotx.io/ui/components/ui/radio-group"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import { approveConnectAction } from "../actions/approve-connect.action"
import type { AuthorizeRequest } from "../lib/authorize-request"

type ConsentFormProps = {
  request: AuthorizeRequest
  workspaces: { id: string; name: string }[]
  denyUrl: string
  labels: {
    workspace: string
    approve: string
    deny: string
    genericError: string
  }
}

export function ConsentForm({
  request,
  workspaces,
  denyUrl,
  labels,
}: ConsentFormProps) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "")
  const [pending, startTransition] = useTransition()

  const approve = () =>
    startTransition(async () => {
      const result = await approveConnectAction(workspaceId, request)
      if (result?.data?.redirectUrl) {
        window.location.assign(result.data.redirectUrl)
        return
      }
      toast.error(result?.serverError ?? labels.genericError)
    })

  return (
    <div className="flex flex-col gap-6">
      {workspaces.length > 1 && (
        <div className="flex flex-col gap-3">
          <Label>{labels.workspace}</Label>
          <RadioGroup
            onValueChange={(next) => setWorkspaceId(String(next))}
            value={workspaceId}
          >
            {workspaces.map((workspace) => (
              <Label
                className="flex items-center gap-3 rounded-lg border p-3 font-normal"
                key={workspace.id}
              >
                <RadioGroupItem value={workspace.id} />
                {workspace.name}
              </Label>
            ))}
          </RadioGroup>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <a className={buttonVariants({ variant: "outline" })} href={denyUrl}>
          {labels.deny}
        </a>
        <Button disabled={pending || !workspaceId} onClick={approve}>
          {labels.approve}
        </Button>
      </div>
    </div>
  )
}
