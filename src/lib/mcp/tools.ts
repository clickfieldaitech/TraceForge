import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { runReadOnlyQuery, UnsafeQueryError } from "./db"
import { SCHEMA_CONTEXT } from "./schema-context"

/**
 * Every tool here is read-only by construction (they only ever call
 * runReadOnlyQuery, which is backed by a Postgres role with SELECT-only
 * grants — see db.ts for the full defense-in-depth story) and is marked
 * `readOnlyHint: true` so a client that respects MCP tool annotations knows
 * it without having to ask.
 */

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true }
}

async function safe<T>(fn: () => Promise<T>): Promise<ReturnType<typeof jsonResult> | ReturnType<typeof errorResult>> {
  try {
    return jsonResult(await fn())
  } catch (err) {
    if (err instanceof UnsafeQueryError) return errorResult(err.message)
    const message = err instanceof Error ? err.message : String(err)
    return errorResult(message)
  }
}

export function registerValveTrackTools(server: McpServer) {
  // ── Schema/business context ────────────────────────────────────────────
  server.registerTool(
    "get_schema_context",
    {
      title: "Get database schema and business context",
      description:
        "Returns a written reference of ValveTrack's database schema and business " +
        "semantics — table meanings, status vocabularies, sign conventions, and common " +
        "mistakes to avoid. Call this FIRST, before writing any raw SQL with the `query` " +
        "tool, unless you already have it from earlier in this conversation.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult(SCHEMA_CONTEXT)
  )

  // ── Generic read-only SQL ───────────────────────────────────────────────
  server.registerTool(
    "query",
    {
      title: "Run a read-only SQL query",
      description:
        "Runs one SELECT (or SELECT-based WITH/CTE) statement against the live ValveTrack " +
        "database and returns the rows. This connection is read-only at the database level " +
        "— INSERT/UPDATE/DELETE/DDL are refused by Postgres itself, not just by this tool, " +
        "so there is nothing to be cautious about: query freely. Call get_schema_context " +
        "first if you haven't already — table/column names and status vocabularies are not " +
        "always guessable, and a wrong guess produces a wrong-but-plausible answer rather " +
        "than an error. Results are capped at 500 rows; aggregate with GROUP BY/SUM in the " +
        "query itself rather than relying on fetching raw rows.",
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .describe("A single SELECT or WITH...SELECT statement. No trailing semicolon needed."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sql }) =>
      safe(async () => {
        const result = await runReadOnlyQuery(sql)
        return {
          columns: result.fields,
          rowCount: result.rowCount,
          truncated: result.truncated,
          rows: result.rows,
        }
      })
  )

  // ── Material movement ───────────────────────────────────────────────────
  server.registerTool(
    "material_movement",
    {
      title: "Material movement summary for an item",
      description:
        "In/out/net quantity and value for one material over a date range, straight from " +
        "the stock ledger (the single source of truth for all stock movement) with the " +
        "correct sign convention already applied. Use this for questions like 'how many kg " +
        "of RM-C-0008 did we issue in the last 3 months' instead of writing raw SQL — it's " +
        "pre-verified correct.",
      inputSchema: {
        item: z
          .string()
          .min(1)
          .describe("Item code or item name (partial match, case-insensitive) — e.g. 'RM-C-0008' or 'wire'."),
        fromDate: z.string().describe("Start date, YYYY-MM-DD (inclusive)."),
        toDate: z.string().describe("End date, YYYY-MM-DD (inclusive)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ item, fromDate, toDate }) =>
      safe(() =>
        runReadOnlyQuery(
          `select
             im.item_code, im.item_name, im.uom,
             sl.transaction_type,
             sl.reference_type,
             sum(sl.qty) as total_qty,
             sum(sl.qty * sl.unit_rate) as total_value
           from stock_ledger sl
           join item_master im on im.id = sl.item_id
           where (im.item_code ilike '%${sqlLikeEscape(item)}%' or im.item_name ilike '%${sqlLikeEscape(item)}%')
             and sl.created_at >= '${sqlDate(fromDate)}'
             and sl.created_at < ('${sqlDate(toDate)}'::date + interval '1 day')
           group by im.item_code, im.item_name, im.uom, sl.transaction_type, sl.reference_type
           order by im.item_code, sl.transaction_type`
        ).then((r) => summarizeMovement(r.rows))
      )
  )

  // ── Stock valuation ─────────────────────────────────────────────────────
  server.registerTool(
    "stock_valuation",
    {
      title: "Current stock valuation",
      description:
        "Current on-hand quantity and value per item (optionally filtered by item/location), " +
        "from the live stock_balances view. Use for 'what's our current stock worth' or " +
        "'how much X do we have right now' questions.",
      inputSchema: {
        item: z.string().optional().describe("Optional item code/name filter (partial match)."),
        locationCode: z.string().optional().describe("Optional storage location code filter (exact match)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ item, locationCode }) =>
      safe(() => {
        const conditions: string[] = ["sb.balance_qty > 0"]
        if (item) {
          conditions.push(
            `(im.item_code ilike '%${sqlLikeEscape(item)}%' or im.item_name ilike '%${sqlLikeEscape(item)}%')`
          )
        }
        if (locationCode) {
          conditions.push(`loc.code = '${sqlLikeEscape(locationCode)}'`)
        }
        return runReadOnlyQuery(
          `select
             im.item_code, im.item_name, im.uom, loc.code as location_code, loc.name as location_name,
             sb.balance_qty, sb.avg_unit_cost, sb.balance_value
           from stock_balances sb
           join item_master im on im.id = sb.item_id
           join storage_locations loc on loc.id = sb.storage_location_id
           where ${conditions.join(" and ")}
           order by sb.balance_value desc`
        )
      })
  )

  // ── Job card summary ────────────────────────────────────────────────────
  server.registerTool(
    "job_card_summary",
    {
      title: "Job card status / activity summary",
      description:
        "Counts and details of job cards, optionally filtered by status, client, or a " +
        "received-date range. Automatically excludes soft-deleted job cards. Use for " +
        "'how many jobs are in progress', 'what's overdue', 'jobs for <client> this quarter'.",
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe(
            "Exact status to filter on: created, wps_pending, wps_uploaded, wps_approved, " +
              "process_assigned, in_process, process_complete, reports_pending, " +
              "reports_complete, dispatch_ready, dispatched, accounts_processing, closed, on_hold."
          ),
        client: z.string().optional().describe("Client name filter (partial match, case-insensitive)."),
        fromDate: z.string().optional().describe("Received-date range start, YYYY-MM-DD."),
        toDate: z.string().optional().describe("Received-date range end, YYYY-MM-DD."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, client, fromDate, toDate }) =>
      safe(() => {
        const conditions: string[] = ["jc.deleted_at is null"]
        if (status) conditions.push(`jc.status = '${sqlLikeEscape(status)}'`)
        if (client) conditions.push(`c.name ilike '%${sqlLikeEscape(client)}%'`)
        if (fromDate) conditions.push(`jc.received_date >= '${sqlDate(fromDate)}'`)
        if (toDate) conditions.push(`jc.received_date <= '${sqlDate(toDate)}'`)
        return runReadOnlyQuery(
          `select jc.status, count(*) as job_count,
                  count(*) filter (where jc.due_date < current_date and jc.status not in ('closed','dispatched','accounts_processing')) as overdue_count
           from job_cards jc
           left join clients c on c.id = jc.client_id
           where ${conditions.join(" and ")}
           group by jc.status
           order by job_count desc`
        )
      })
  )

  // ── Dispatch / sales summary ────────────────────────────────────────────
  server.registerTool(
    "dispatch_summary",
    {
      title: "Dispatch and invoicing summary",
      description:
        "What shipped, to whom, and its invoiced/paid value over a date range. Joins " +
        "dispatches + accounts + job_cards + clients. Use for revenue/sales-style questions " +
        "— note invoice_value (what was billed) and payment_amount (what actually came in) " +
        "can differ.",
      inputSchema: {
        fromDate: z.string().describe("Dispatch date range start, YYYY-MM-DD."),
        toDate: z.string().describe("Dispatch date range end, YYYY-MM-DD."),
        client: z.string().optional().describe("Client name filter (partial match)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ fromDate, toDate, client }) =>
      safe(() => {
        const conditions: string[] = [
          `d.dispatch_date >= '${sqlDate(fromDate)}'`,
          `d.dispatch_date <= '${sqlDate(toDate)}'`,
        ]
        if (client) conditions.push(`c.name ilike '%${sqlLikeEscape(client)}%'`)
        return runReadOnlyQuery(
          `select
             jc.jc_number, c.name as client_name, d.dispatch_date, d.dc_number,
             a.invoice_number, a.invoice_value, a.payment_status, a.payment_amount
           from dispatches d
           join job_cards jc on jc.id = d.job_card_id
           left join clients c on c.id = jc.client_id
           left join accounts a on a.job_card_id = jc.id
           where ${conditions.join(" and ")}
           order by d.dispatch_date desc`
        )
      })
  )
}

// ── Small helpers ────────────────────────────────────────────────────────

/**
 * These tools build SQL by interpolating validated, narrow-purpose inputs
 * (a date, a %-wildcard search term) rather than accepting arbitrary SQL —
 * unlike the `query` tool, there's no user-supplied SQL syntax here to
 * reject, just string/date values to escape before they land inside a
 * literal. Both helpers reject anything that isn't the shape they expect
 * rather than trying to sanitize it.
 */
function sqlLikeEscape(value: string): string {
  if (/['";\\]/.test(value)) {
    throw new UnsafeQueryError("Search text can't contain quotes, semicolons, or backslashes.")
  }
  return value.replace(/[%_]/g, (c) => `\\${c}`)
}

function sqlDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new UnsafeQueryError(`"${value}" isn't a YYYY-MM-DD date.`)
  }
  return value
}

function summarizeMovement(rows: Record<string, unknown>[]) {
  let totalIn = 0
  let totalOut = 0
  let valueIn = 0
  let valueOut = 0
  for (const r of rows) {
    const qty = Number(r.total_qty)
    const value = Number(r.total_value)
    if (String(r.transaction_type).endsWith("_in")) {
      totalIn += qty
      valueIn += value
    } else {
      totalOut += qty
      valueOut += value
    }
  }
  return {
    netQty: totalIn - totalOut,
    netValue: valueIn - valueOut,
    totalIn,
    totalOut,
    byTransactionType: rows,
  }
}
