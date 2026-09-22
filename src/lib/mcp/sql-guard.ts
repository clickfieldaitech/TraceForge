/**
 * Pure, dependency-free — deliberately has no import of `pg` or anything
 * else that touches a live connection, so it can be unit-tested without
 * pulling in a database driver (which needs Node-only globals `pg`'s crypto
 * module reaches for at import time, unavailable under Jest's jsdom
 * environment) and so its logic is auditable in isolation from I/O.
 *
 * This is the MCP read-only query tool's app-layer guard — a courtesy/UX
 * layer, NOT the real security boundary. The actual boundary is the
 * `mcp_reader` Postgres role's grants (SELECT only, verified empirically:
 * connected as the role directly and confirmed INSERT/UPDATE/DELETE/CREATE
 * TABLE are all refused with "permission denied"). This exists so a bad
 * query gets a clear, immediate, on-topic error instead of a raw Postgres
 * permission failure.
 */

export class UnsafeQueryError extends Error {}

/**
 * Strips string literals and comments before keyword-scanning, so a write
 * keyword sitting inside a quoted string (e.g. a WHERE clause matching the
 * literal text "update") doesn't cause a false rejection, and so a
 * semicolon inside a string literal doesn't cause a false "multiple
 * statements" rejection either. Not a full SQL parser — doesn't need to be,
 * since the database role is what actually enforces read-only; this exists
 * to give a fast, clear error instead of leaning on that.
 */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''") // single-quoted string literals (with '' escapes)
    .replace(/"(?:[^"]|"")*"/g, '""') // double-quoted identifiers
    .replace(/--[^\n]*/g, "") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
}

const FORBIDDEN_KEYWORDS =
  /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|call|do|vacuum|reindex|refresh|lock|comment|merge|execute|prepare|listen|notify|unlisten|security|set\s+role|reset|discard)\b/i

/** Throws UnsafeQueryError if `sql` is anything other than one read query. */
export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim()
  if (!trimmed) throw new UnsafeQueryError("Empty query.")

  const stripped = stripLiteralsAndComments(trimmed)

  // Reject multiple statements — a trailing semicolon is fine, an internal
  // one (","; more SQL after it) is not.
  const withoutTrailingSemicolon = stripped.replace(/;\s*$/, "")
  if (withoutTrailingSemicolon.includes(";")) {
    throw new UnsafeQueryError(
      "Only a single SQL statement is allowed per call — remove any additional statements."
    )
  }

  if (!/^\s*(select|with)\b/i.test(stripped)) {
    throw new UnsafeQueryError(
      "Only SELECT (or a SELECT-based WITH / CTE) statements are allowed. This connection is read-only and cannot INSERT, UPDATE, DELETE, or run DDL."
    )
  }

  if (FORBIDDEN_KEYWORDS.test(stripped)) {
    throw new UnsafeQueryError(
      "That statement contains a keyword that isn't allowed on this read-only connection."
    )
  }
}
