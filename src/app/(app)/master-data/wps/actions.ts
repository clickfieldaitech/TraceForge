"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { requireRole } from "@/lib/auth"
import { wpsMasterSchema, type WpsMasterInput } from "@/lib/validations/wps-master"
import { extractWpsFromFile, isWpsExtractionConfigured } from "@/lib/ai/wps-extraction"
import { checkRateLimit } from "@/lib/rate-limit"
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from "@/lib/documents/storage-utils"
import { validateFileSignature } from "@/lib/documents/file-signature"
import type { WpsMasterStatus } from "@/types/database"
import { sanitizeError } from "@/lib/security"

// extractWpsFromDocument can fall back across Gemini models with per-attempt
// timeouts totalling up to ~56s worst case (see wps-extraction.ts) — the
// platform default (10s) would kill it mid-fallback, turning a recoverable
// 503 into a hard failure before the fallback model even got a turn.
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildJsonFields(data: WpsMasterInput) {
  const gas_json =
    data.gas_shielding || data.gas_trailing || data.gas_backing || data.gas_composition || data.gas_flow_rate
      ? {
          shielding:   data.gas_shielding   ?? null,
          trailing:    data.gas_trailing    ?? null,
          backing:     data.gas_backing     ?? null,
          composition: data.gas_composition ?? null,
          flow_rate:   data.gas_flow_rate   ?? null,
        }
      : null

  const electrical_params_json =
    data.elec_current_type || data.elec_polarity || data.elec_current_range ||
    data.elec_voltage_range || data.elec_travel_speed || data.elec_heat_input ||
    data.elec_tungsten_electrode_size
      ? {
          current_type:           data.elec_current_type           ?? null,
          polarity:               data.elec_polarity                ?? null,
          current_range:          data.elec_current_range           ?? null,
          voltage_range:          data.elec_voltage_range           ?? null,
          travel_speed:           data.elec_travel_speed            ?? null,
          heat_input:             data.elec_heat_input              ?? null,
          tungsten_electrode_size: data.elec_tungsten_electrode_size ?? null,
        }
      : null

  const technique_json =
    data.tech_bead_type || data.tech_oscillation || data.tech_pass_type ||
    data.tech_multi_single_layer || data.tech_multi_single_electrode || data.tech_back_gouging ||
    data.tech_contact_tube_distance || data.tech_orifice_gas_cup_size || data.tech_cleaning_method ||
    data.tech_electrode_spacing || data.tech_change_of_process || data.tech_peening ||
    data.tech_transfer_mode || data.tech_torch_orifice_dia || data.tech_filler_metal_delivery ||
    data.tech_use_of_thermal_process
      ? {
          bead_type:              data.tech_bead_type              ?? null,
          oscillation:            data.tech_oscillation            ?? null,
          pass_type:              data.tech_pass_type              ?? null,
          multi_single_layer:     data.tech_multi_single_layer     ?? null,
          multi_single_electrode: data.tech_multi_single_electrode ?? null,
          back_gouging:           data.tech_back_gouging           ?? null,
          contact_tube_distance:  data.tech_contact_tube_distance  ?? null,
          orifice_gas_cup_size:   data.tech_orifice_gas_cup_size   ?? null,
          cleaning_method:        data.tech_cleaning_method        ?? null,
          electrode_spacing:      data.tech_electrode_spacing      ?? null,
          change_of_process:      data.tech_change_of_process      ?? null,
          peening:                data.tech_peening                ?? null,
          transfer_mode:          data.tech_transfer_mode          ?? null,
          torch_orifice_dia:      data.tech_torch_orifice_dia      ?? null,
          filler_metal_delivery:  data.tech_filler_metal_delivery  ?? null,
          use_of_thermal_process: data.tech_use_of_thermal_process ?? null,
        }
      : null

  const joint_json =
    data.joint_root_gap || data.joint_root_face || data.joint_groove_angle ||
    data.joint_groove_length || data.joint_groove_width || data.joint_backing || data.joint_retainer
      ? {
          root_gap:      data.joint_root_gap      ?? null,
          root_face:     data.joint_root_face     ?? null,
          groove_angle:  data.joint_groove_angle  ?? null,
          groove_length: data.joint_groove_length ?? null,
          groove_width:  data.joint_groove_width  ?? null,
          backing:       data.joint_backing       ?? null,
          retainer:      data.joint_retainer      ?? null,
        }
      : null

  const base_metal_json =
    data.base_material_spec || data.base_material_type_grade || data.base_material_pno ||
    data.base_material_heat_no || data.test_coupon_thickness || data.test_coupon_diameter
      ? {
          material_spec:          data.base_material_spec       ?? null,
          type_grade:             data.base_material_type_grade ?? null,
          p_no:                   data.base_material_pno        ?? null,
          heat_no:                data.base_material_heat_no    ?? null,
          test_coupon_thickness:  data.test_coupon_thickness    ?? null,
          test_coupon_diameter:   data.test_coupon_diameter     ?? null,
        }
      : null

  const filler_metal_json =
    data.filler_sfa_spec || data.filler_fno || data.filler_ano ||
    data.filler_feed_rate || data.weld_metal_thickness
      ? {
          sfa_spec:             data.filler_sfa_spec      ?? null,
          f_no:                 data.filler_fno           ?? null,
          a_no:                 data.filler_ano           ?? null,
          feed_rate:            data.filler_feed_rate     ?? null,
          weld_metal_thickness: data.weld_metal_thickness ?? null,
        }
      : null

  const weld_passes_json = data.weld_passes?.filter((r) => Object.values(r).some((v) => v)) ?? null
  const tensile_tests_json = data.tensile_tests?.filter((r) => Object.values(r).some((v) => v)) ?? null

  return {
    gas_json, electrical_params_json, technique_json,
    joint_json, base_metal_json, filler_metal_json,
    weld_passes_json: weld_passes_json?.length ? weld_passes_json : null,
    tensile_tests_json: tensile_tests_json?.length ? tensile_tests_json : null,
  }
}

function sanitize(v: string | null | undefined): string | null {
  if (!v || v.trim() === "") return null
  return v.trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// createWpsMaster
// ─────────────────────────────────────────────────────────────────────────────
export async function createWpsMaster(
  raw: WpsMasterInput,
): Promise<{ error?: string; id?: string }> {
  const guard = await requireRole(["admin", "qa"])
  if (guard.error) return { error: guard.error }
  const { supabase, user } = guard

  const parsed = wpsMasterSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Validation error" }
  }
  const data = parsed.data
  const {
    gas_json, electrical_params_json, technique_json,
    joint_json, base_metal_json, filler_metal_json,
    weld_passes_json, tensile_tests_json,
  } = buildJsonFields(data)

  const { data: row, error } = await supabase
    .from("wps_master")
    .insert({
      wps_no:                sanitize(data.wps_no) ?? "",
      pqr_no:                sanitize(data.pqr_no),
      welding_process:       sanitize(data.welding_process),
      type:                  sanitize(data.type),
      scope:                 sanitize(data.scope),
      date_of_welding:       data.date_of_welding || null,
      joint_design:          sanitize(data.joint_design),
      base_material:         sanitize(data.base_material),
      filler_material:       sanitize(data.filler_material),
      filler_aws_class:      sanitize(data.filler_aws_class),
      filler_size:           sanitize(data.filler_size),
      position:              sanitize(data.position),
      weld_progression:      sanitize(data.weld_progression),
      preheat_min:           data.preheat_min ? parseFloat(data.preheat_min) : null,
      interpass_max:         data.interpass_max ? parseFloat(data.interpass_max) : null,
      preheat_other:         sanitize(data.preheat_other),
      pwht_required:         data.pwht_required,
      pwht_temp_min:         data.pwht_temp_min ? parseFloat(data.pwht_temp_min) : null,
      pwht_temp_max:         data.pwht_temp_max ? parseFloat(data.pwht_temp_max) : null,
      pwht_time_range:       sanitize(data.pwht_time_range),
      pwht_cooling_method:   sanitize(data.pwht_cooling_method),
      pwht_rate_of_heating:  sanitize(data.pwht_rate_of_heating),
      pwht_loading_temp:     sanitize(data.pwht_loading_temp),
      pwht_unloading_temp:   sanitize(data.pwht_unloading_temp),
      gas_json,
      electrical_params_json,
      technique_json,
      joint_json,
      base_metal_json,
      filler_metal_json,
      weld_passes_json,
      tensile_tests_json,
      approved_by:           sanitize(data.approved_by),
      reviewed_by:           sanitize(data.reviewed_by),
      revision:              sanitize(data.revision) ?? "Rev 0",
      effective_date:        data.effective_date || null,
      notes:                 sanitize(data.notes),
      status:                "draft" as WpsMasterStatus,
      created_by:            user.id,
    })
    .select("id")
    .single()

  if (error) return { error: sanitizeError(error) }

  revalidatePath("/master-data/wps")
  return { id: (row as { id: string }).id }
}

// ─────────────────────────────────────────────────────────────────────────────
// updateWpsMaster
// ─────────────────────────────────────────────────────────────────────────────
export async function updateWpsMaster(
  id: string,
  raw: WpsMasterInput,
): Promise<{ error?: string }> {
  const guard = await requireRole(["admin", "qa"])
  if (guard.error) return { error: guard.error }
  const { supabase, profile } = guard

  const parsed = wpsMasterSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Validation error" }
  }
  const data = parsed.data

  // QA can only edit drafts; admin can edit any non-superseded
  if (profile?.role === "qa") {
    const { data: existing } = await supabase
      .from("wps_master")
      .select("status")
      .eq("id", id)
      .single()
    if (!existing) return { error: "WPS record not found." }
    if ((existing as { status: string }).status !== "draft") {
      return { error: "QA can only edit WPS records in Draft status." }
    }
  }

  const {
    gas_json, electrical_params_json, technique_json,
    joint_json, base_metal_json, filler_metal_json,
    weld_passes_json, tensile_tests_json,
  } = buildJsonFields(data)

  const { error } = await supabase
    .from("wps_master")
    .update({
      wps_no:                sanitize(data.wps_no) ?? "",
      pqr_no:                sanitize(data.pqr_no),
      welding_process:       sanitize(data.welding_process),
      type:                  sanitize(data.type),
      scope:                 sanitize(data.scope),
      date_of_welding:       data.date_of_welding || null,
      joint_design:          sanitize(data.joint_design),
      base_material:         sanitize(data.base_material),
      filler_material:       sanitize(data.filler_material),
      filler_aws_class:      sanitize(data.filler_aws_class),
      filler_size:           sanitize(data.filler_size),
      position:              sanitize(data.position),
      weld_progression:      sanitize(data.weld_progression),
      preheat_min:           data.preheat_min ? parseFloat(data.preheat_min) : null,
      interpass_max:         data.interpass_max ? parseFloat(data.interpass_max) : null,
      preheat_other:         sanitize(data.preheat_other),
      pwht_required:         data.pwht_required,
      pwht_temp_min:         data.pwht_temp_min ? parseFloat(data.pwht_temp_min) : null,
      pwht_temp_max:         data.pwht_temp_max ? parseFloat(data.pwht_temp_max) : null,
      pwht_time_range:       sanitize(data.pwht_time_range),
      pwht_cooling_method:   sanitize(data.pwht_cooling_method),
      pwht_rate_of_heating:  sanitize(data.pwht_rate_of_heating),
      pwht_loading_temp:     sanitize(data.pwht_loading_temp),
      pwht_unloading_temp:   sanitize(data.pwht_unloading_temp),
      gas_json,
      electrical_params_json,
      technique_json,
      joint_json,
      base_metal_json,
      filler_metal_json,
      weld_passes_json,
      tensile_tests_json,
      approved_by:           sanitize(data.approved_by),
      reviewed_by:           sanitize(data.reviewed_by),
      revision:              sanitize(data.revision) ?? "Rev 0",
      effective_date:        data.effective_date || null,
      notes:                 sanitize(data.notes),
    })
    .eq("id", id)

  if (error) return { error: sanitizeError(error) }

  revalidatePath("/master-data/wps")
  revalidatePath(`/master-data/wps/${id}`)
  return {}
}

// ─────────────────────────────────────────────────────────────────────────────
// approveWpsMaster — admin only, transitions draft → approved
// ─────────────────────────────────────────────────────────────────────────────
export async function approveWpsMaster(
  id: string,
): Promise<{ error?: string }> {
  const guard = await requireRole(["admin"])
  if (guard.error) return { error: guard.error }
  const { supabase } = guard

  const { data: existing, error: fetchErr } = await supabase
    .from("wps_master")
    .select("status")
    .eq("id", id)
    .single()

  if (fetchErr || !existing) return { error: "WPS record not found." }
  if ((existing as { status: string }).status !== "draft") {
    return { error: "Only Draft WPS records can be approved." }
  }

  const { error } = await supabase
    .from("wps_master")
    .update({ status: "approved" as WpsMasterStatus })
    .eq("id", id)

  if (error) return { error: sanitizeError(error) }

  revalidatePath("/master-data/wps")
  revalidatePath(`/master-data/wps/${id}`)
  return {}
}

// ─────────────────────────────────────────────────────────────────────────────
// supersedeWpsMaster — admin only, transitions approved → superseded
// ─────────────────────────────────────────────────────────────────────────────
export async function supersedeWpsMaster(
  id: string,
): Promise<{ error?: string }> {
  const guard = await requireRole(["admin"])
  if (guard.error) return { error: guard.error }
  const { supabase } = guard

  const { data: existing, error: fetchErr } = await supabase
    .from("wps_master")
    .select("status")
    .eq("id", id)
    .single()

  if (fetchErr || !existing) return { error: "WPS record not found." }
  if ((existing as { status: string }).status !== "approved") {
    return { error: "Only Approved WPS records can be superseded." }
  }

  const { error } = await supabase
    .from("wps_master")
    .update({ status: "superseded" as WpsMasterStatus })
    .eq("id", id)

  if (error) return { error: sanitizeError(error) }

  revalidatePath("/master-data/wps")
  revalidatePath(`/master-data/wps/${id}`)
  return {}
}

// ─────────────────────────────────────────────────────────────────────────────
// createWpsMasterAndRedirect — used by the /new form (server action form submit)
// ─────────────────────────────────────────────────────────────────────────────
export async function createWpsMasterAndRedirect(
  raw: WpsMasterInput,
): Promise<{ error?: string }> {
  const result = await createWpsMaster(raw)
  if (result.error) return { error: result.error }
  redirect(`/master-data/wps/${result.id}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// extractWpsFromDocument — reads an uploaded WPS PDF/image and returns field
// values to pre-fill the New WPS form with. Never writes to the database;
// the user still reviews and saves through the normal createWpsMaster path.
// ─────────────────────────────────────────────────────────────────────────────
const IMAGE_MIME_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"]

export async function extractWpsFromDocument(
  formData: FormData,
): Promise<{ error?: string; data?: Record<string, unknown> }> {
  const guard = await requireRole(["admin", "qa"])
  if (guard.error) return { error: guard.error }
  const { user } = guard

  if (!isWpsExtractionConfigured()) {
    return { error: "WPS auto-extraction is not set up yet. Ask an admin to configure it, or fill the form manually." }
  }

  // Generous per-user cap — nowhere near Gemini's free daily quota, just
  // guards against a runaway client loop burning the shared allowance.
  const rate = await checkRateLimit(`wps-extract:${user.id}`, 20, 60 * 60 * 1000)
  if (!rate.allowed) {
    return { error: "Extraction limit reached for now — please try again in a bit, or fill the form manually." }
  }

  const file = formData.get("file")
  if (!(file instanceof File)) return { error: "No file was uploaded." }
  if (file.size === 0) return { error: "The uploaded file is empty." }
  if (file.size > MAX_FILE_SIZE_BYTES) return { error: "File is too large (max 50 MB)." }
  if (!ALLOWED_MIME_TYPES.includes(file.type as (typeof ALLOWED_MIME_TYPES)[number]) || !IMAGE_MIME_TYPES.includes(file.type)) {
    return { error: "Only PDF, JPEG, PNG, or WEBP files are supported for extraction." }
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const sigError = validateFileSignature(file.name, bytes)
  if (sigError) return { error: sigError }

  const result = await extractWpsFromFile(bytes, file.type)
  if ("error" in result) return { error: result.error }
  return { data: result.data }
}
