// Server-only: extracts WPS Master fields from an uploaded PDF/image using
// Gemini's vision + structured-output API. Called from the "Extract from
// PDF/Image" action on the New WPS form — never writes to the database
// itself, it only returns field values for the form to pre-fill so a human
// reviews and corrects before saving.
//
// Uses a plain fetch() against the Gemini REST endpoint rather than the SDK
// to avoid a new dependency, matching how Supabase/Resend are called
// elsewhere in this codebase.

// "gemini-flash-latest" is Google's maintained alias for their current
// recommended flash model — avoids hardcoding a version that later gets
// deprecated for new API keys (as happened with "gemini-2.5-flash").
const GEMINI_MODEL = "gemini-flash-latest"
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

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

// Gemini's structured-output mode (responseSchema, which this call relies on)
// intermittently returns 503 "high demand" under normal Google-side load —
// observed ~1-in-3 requests failing this way even when the API key, quota,
// and payload are all fine. Retrying almost always succeeds within a couple
// of attempts, so retry automatically instead of making the user re-click.
const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 1500

async function callGemini(apiKey: string, body: unknown): Promise<Response | { networkError: true }> {
  try {
    return await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
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

  let res: Response | undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await callGemini(apiKey, body)

    if ("networkError" in result) {
      if (attempt === MAX_ATTEMPTS) return { error: "Could not reach the extraction service. Please try again." }
      await sleep(RETRY_BASE_DELAY_MS * attempt)
      continue
    }

    // Only 503 (transient overload) is worth retrying — a 4xx means the
    // request itself is wrong and will fail identically every time.
    if (result.status === 503 && attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_BASE_DELAY_MS * attempt)
      continue
    }

    res = result
    break
  }

  if (!res) {
    return { error: "Extraction failed after multiple attempts. Please try again or fill the form manually." }
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
