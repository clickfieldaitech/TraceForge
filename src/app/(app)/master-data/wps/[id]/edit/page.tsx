import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { requireAuth } from "@/lib/auth"
import { WpsForm } from "@/components/master-data/wps-form"
import { wpsMasterToFormValues } from "@/lib/form-mappers/wps-master"
import type { WpsMaster, UserRole } from "@/types/database"

export const metadata = { title: "Edit WPS Master — ValveTrack" }

// See new/page.tsx for why this lives here — the extract dialog is also
// reachable from the edit form, so it needs the same longer budget.
export const maxDuration = 60

export default async function EditWpsMasterPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { supabase, profile } = await requireAuth()

  const role = (profile?.role ?? "operator") as UserRole
  if (!["admin", "qa"].includes(role)) redirect(`/master-data/wps/${id}`)

  const { data: wps } = await supabase
    .from("wps_master")
    .select("*")
    .eq("id", id)
    .single()

  if (!wps) notFound()

  const record = wps as WpsMaster

  // Superseded records cannot be edited at all
  if (record.status === "superseded") redirect(`/master-data/wps/${id}`)

  // QA can only edit draft records
  if (role === "qa" && record.status !== "draft") redirect(`/master-data/wps/${id}`)

  const defaultValues = wpsMasterToFormValues(record)

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <Link
          href={`/master-data/wps/${id}`}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft className="h-4 w-4" /> Back to WPS Detail
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Edit WPS Master</h1>
        <p className="mt-1 text-sm font-mono text-muted-foreground">{record.wps_no}</p>
      </div>

      <WpsForm mode="edit" wpsId={id} defaultValues={defaultValues} />
    </div>
  )
}
