import { Pool } from "pg"
import { assertReadOnlySql } from "./sql-guard"

export { UnsafeQueryError, assertReadOnlySql } from "./sql-guard"

/**
 * All access from the MCP server goes through this one module — there is no
 * other code path in src/lib/mcp that talks to Postgres directly. That makes
 * "is this actually read-only" a property of one file, not something that
 * has to hold true across every tool handler independently.
 *
 * Defense in depth, three independent layers, any one of which alone would
 * stop a write:
 *   1. The `mcp_reader` Postgres role (supabase/migrations/0062) has SELECT
 *      granted and nothing else — verified empirically by connecting as it
 *      and confirming INSERT/UPDATE/DELETE/CREATE TABLE are all refused with
 *      "permission denied", before this role was ever wired into app code.
 *      This is the real boundary; the other two are belt-and-suspenders.
 *   2. Every query runs inside an explicit `BEGIN READ ONLY` transaction —
 *      Postgres itself refuses a write attempt inside one, independent of
 *      role grants.
 *   3. `assertReadOnlySql` (sql-guard.ts) rejects anything that isn't a
 *      single SELECT/WITH statement before it's even sent to the database,
 *      so a malformed or adversarial query gets a clear, immediate error
 *      instead of quietly reaching Postgres to find out.
 */

let pool: Pool | null = null

function getPool(): Pool {
  if (pool) return pool
  const connectionString = process.env.MCP_READER_DATABASE_URL
  if (!connectionString) {
    throw new Error(
      "MCP_READER_DATABASE_URL is not configured — the MCP server has no database to read from."
    )
  }
  pool = new Pool({
    connectionString,
    // Encrypted but not cert-verified — Supabase's direct-connection host
    // presents a cert our CA bundle doesn't chain to. IMPORTANT: don't also
    // put ?sslmode=... on the connection string — pg gives a URL sslmode
    // query param precedence over this option, and `require` there means
    // "verify", silently overriding this and breaking the connection with
    // "self-signed certificate in certificate chain" (hit exactly this
    // during setup).
    ssl: { rejectUnauthorized: false },
    // Low-traffic reporting tool (a person asking occasional questions), not
    // a high-concurrency path — a small pool avoids eating into Supabase's
    // direct-connection limit that the main app also draws from.
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
  return pool
}

const MAX_ROWS = 500

export type QueryResult = {
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  fields: string[]
}

/**
 * Runs one read-only SQL query. `sql` must be a single SELECT/WITH
 * statement — see assertReadOnlySql. Every call gets its own connection
 * wrapped in `BEGIN READ ONLY … ROLLBACK` (rollback, not commit — a SELECT
 * has nothing to commit, and rollback is the correct way to end a read-only
 * transaction cleanly either way).
 */
export async function runReadOnlyQuery(sql: string): Promise<QueryResult> {
  assertReadOnlySql(sql)

  const client = await getPool().connect()
  try {
    await client.query("BEGIN READ ONLY")
    try {
      const result = await client.query(sql)
      await client.query("ROLLBACK")

      const truncated = result.rows.length > MAX_ROWS
      return {
        rows: truncated ? result.rows.slice(0, MAX_ROWS) : result.rows,
        rowCount: result.rows.length,
        truncated,
        fields: result.fields?.map((f) => f.name) ?? [],
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {})
      throw err
    }
  } finally {
    client.release()
  }
}
