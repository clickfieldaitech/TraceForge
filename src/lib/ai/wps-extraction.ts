// Server-only: extracts WPS Master fields from an uploaded PDF/image using
// Gemini's vision + structured-output API. Called from the "Extract from
// PDF/Image" action on the New WPS form — never writes to the database
// itself, it only returns field values for the form to pre-fill so a human
// reviews and corrects before saving.
//
// Uses a plain fetch() against the Gemini REST endpoint rather than the SDK
// to avoid a new dependency, matching how Supabase/Resend are called
// elsewhere in this codebase.

// Two Google-maintained aliases, tried in order — never a hardcoded version
// number (that's what deprecated "gemini-2.5-flash" out from under us: it
// now 404s with "no longer available to new users"). "-latest" always
// resolves to Google's current full model, which is fastest to get new
// capabilities but also the first place everyone's traffic lands right after
// a release, causing real, observed 503 "high demand" spells lasting well
// past a few retries (20-30s per failed attempt, ~2 in 3 failing). The
// "-lite" alias is a smaller, separately-provisioned model with its own
// capacity pool — reliably fast even while the full model is overloaded — so
// it's a genuine fallback, not just hitting the same congestion twice.
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"] as const
const GEMINI_ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

export function isWpsExtractionConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY
}

// String, nullable field names from wpsMasterSchema (excluding pwht_required,
// which is boolean — every other field, including wps_no/revision, is still
// reviewed by the user before saving via the form's normal validation).
const STRING_FIELDS = [
  "wps_no", "revision",
  "pqr_no", "welding_process", "type", "scope", "date_of_welding",
  "joint_design", "base_material", "filler_material", "filler_aws_class", "filler_size", "position",
  "preheat_min", "interpass_max", "preheat_other",
  "pwht_temp_min", "pwht_temp_max", "pwht_time_range", "pwht_cooling_method",
  "pwht_rate_of_heating", "pwht_loading_temp", "pwht_unloading_temp",
  "joint_root_gap", "joint_root_face", "joint_groove_angle", "joint_groove_length",
  "joint_groove_width", "joint_backing", "joint_retainer",
  "base_material_spec", "base_material_type_grade", "base_material_pno", "base_material_heat_no",
  "test_coupon_thickness", "test_coupon_diameter",
  "filler_sfa_spec", "filler_fno", "filler_ano", "filler_feed_rate", "weld_metal_thickness",
  "weld_progression",
  "gas_shielding", "gas_trailing", "gas_backing", "gas_composition", "gas_flow_rate",
  "elec_current_type", "elec_polarity", "elec_current_range", "elec_voltage_range",
  "elec_travel_speed", "elec_heat_input", "elec_tungsten_electrode_size",
  "tech_bead_type", "tech_oscillation", "tech_pass_type", "tech_multi_single_layer",
  "tech_multi_single_electrode", "tech_back_gouging", "tech_contact_tube_distance",
  "tech_orifice_gas_cup_size", "tech_cleaning_method", "tech_electrode_spacing",
  "tech_change_of_process", "tech_peening", "tech_transfer_mode", "tech_torch_orifice_dia",
  "tech_filler_metal_delivery", "tech_use_of_thermal_process",
  "approved_by", "reviewed_by", "effective_date", "notes",
] as const

const WELD_PASS_FIELDS = [
  "pass_label", "process", "filler_classification", "filler_diameter",
  "current_type_polarity", "amps_range", "volts_range", "travel_speed_range", "heat_input",
] as const

const TENSILE_TEST_FIELDS = [
  "specimen_no", "width", "thickness", "area",
  "ultimate_load", "ultimate_stress", "failure_type_location",
] as const

function stringProps(fields: readonly string[]) {
  return Object.fromEntries(fields.map((f) => [f, { type: "STRING", nullable: true }]))
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    ...stringProps(STRING_FIELDS),
    pwht_required: { type: "BOOLEAN", nullable: true },
    weld_passes: {
      type: "ARRAY",
      nullable: true,
      items: { type: "OBJECT", properties: stringProps(WELD_PASS_FIELDS) },
    },
    tensile_tests: {
      type: "ARRAY",
      nullable: true,
      items: { type: "OBJECT", properties: stringProps(TENSILE_TEST_FIELDS) },
    },
  },
}

const EXTRACTION_PROMPT = `You are reading a scanned Welding Procedure Specification (WPS) document, \
typically following ASME IX QW-4xx sections. Extract every field you can clearly read into the \
provided JSON schema. Leave a field null if it is not present, illegible, or you are not confident \
about its value — never guess. For the weld_passes and tensile_tests tables, return one array entry \
per row of the table exactly as printed. Return values as plain text/numbers as they appear on the \
document (e.g. "150-180" for a range, not just the first number).`

export type WpsExtractionResult =
  | { data: Record<string, unknown> }
  | { error: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Per model: how many attempts, and how long to wait before giving up on one
// attempt and moving on. The full model gets exactly one shot with a tight
// timeout — when it's overloaded it takes 20-30s to even fail, so a second
// attempt on it just burns the function's time budget for the same bad odds.
// The lite model gets two attempts with a longer timeout since it's small
// and fast (~2s observed) even while the full model is struggling; a rare
// slow lite response still deserves its full timeout rather than an early cut.
const ATTEMPT_PLAN: Record<(typeof GEMINI_MODELS)[number], { attempts: number; timeoutMs: number }> = {
  "gemini-flash-latest": { attempts: 1, timeoutMs: 15_000 },
  "gemini-flash-lite-latest": { attempts: 2, timeoutMs: 20_000 },
}
const RETRY_BACKOFF_MS = 1_500

async function callGemini(
  model: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response | { networkError: true }> {
  try {
    return await fetch(`${GEMINI_ENDPOINT(model)}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return { networkError: true }
  }
}

export async function extractWpsFromFile(
  bytes: Buffer,
  mimeType: string,
): Promise<WpsExtractionResult> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return { error: "WPS extraction is not configured: set GEMINI_API_KEY in the environment." }
  }

  const body = {
    contents: [
      {
        parts: [
          { text: EXTRACTION_PROMPT },
          { inline_data: { mime_type: mimeType, data: bytes.toString("base64") } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  }

  // `res` ends up holding either the first non-503 response (success or a
  // real 4xx we should report as-is) or, if every model/attempt came back
  // 503, the last 503 seen — undefined only if every attempt threw
  // (network-level failure, not an HTTP response at all).
  let res: Response | undefined
  outer: for (const model of GEMINI_MODELS) {
    const { attempts, timeoutMs } = ATTEMPT_PLAN[model]
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await callGemini(model, apiKey, body, timeoutMs)

      if ("networkError" in result) {
        if (attempt < attempts) await sleep(RETRY_BACKOFF_MS)
        continue
      }

      // 503 (transient overload) and 429 (rate limit — real on the free
      // tier, and more likely to trip here since a fallback attempt is a
      // second request) are both worth retrying/falling back on. Any other
      // 4xx means the request itself is wrong and will fail identically on
      // every model, so report it immediately instead of burning the
      // remaining time budget on attempts that can't succeed.
      if (result.status === 503 || result.status === 429) {
        res = result
        if (attempt < attempts) await sleep(RETRY_BACKOFF_MS)
        continue
      }

      res = result
      break outer
    }
  }

  if (!res) {
    return { error: "Could not reach the extraction service. Please try again." }
  }

  if (!res.ok) {
    // Don't leak upstream error bodies (may include the API key echoed in some error paths).
    return { error: `Extraction failed (${res.status}). Please try again or fill the form manually.` }
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { error: "Extraction service returned an unreadable response." }
  }

  const text = (json as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  })?.candidates?.[0]?.content?.parts?.[0]?.text

  if (!text) {
    return { error: "The document could not be read. Please fill the form manually." }
  }

  try {
    const data = JSON.parse(text) as Record<string, unknown>
    return { data }
  } catch {
    return { error: "Extraction returned malformed data. Please fill the form manually." }
  }
}
