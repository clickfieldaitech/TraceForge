import { assertReadOnlySql, UnsafeQueryError } from "@/lib/mcp/sql-guard"

/**
 * This is the app-layer guard in the MCP server's read-only query tool — a
 * courtesy/UX layer, NOT the real security boundary (that's the `mcp_reader`
 * Postgres role's grants, which were verified empirically against the live
 * database: connected as the role directly and confirmed INSERT/UPDATE/
 * DELETE/CREATE TABLE are all refused with "permission denied"). Still worth
 * locking in with tests, since a good error message here beats a raw
 * "permission denied" reaching the database at all.
 */

function isSafe(sql: string) {
  expect(() => assertReadOnlySql(sql)).not.toThrow()
}

function isUnsafe(sql: string) {
  expect(() => assertReadOnlySql(sql)).toThrow(UnsafeQueryError)
}

describe("assertReadOnlySql — accepts legitimate reads", () => {
  it("accepts a plain SELECT", () => {
    isSafe("SELECT * FROM job_cards")
  })

  it("accepts a SELECT with a trailing semicolon", () => {
    isSafe("SELECT * FROM job_cards;")
  })

  it("accepts a WITH / CTE query", () => {
    isSafe("WITH recent AS (SELECT * FROM job_cards) SELECT * FROM recent")
  })

  it("accepts lowercase and mixed-case select/with", () => {
    isSafe("select 1")
    isSafe("With x as (select 1) select * from x")
  })

  it("accepts a string literal that happens to contain a forbidden word", () => {
    isSafe("SELECT * FROM job_cards WHERE description ILIKE '%update the valve%'")
  })

  it("accepts a semicolon inside a string literal", () => {
    isSafe("SELECT * FROM job_cards WHERE description = 'a; b'")
  })

  it("accepts SQL comments containing forbidden words", () => {
    isSafe("SELECT * FROM job_cards -- don't delete this row\n")
    isSafe("SELECT /* insert note */ * FROM job_cards")
  })
})

describe("assertReadOnlySql — rejects anything that could write", () => {
  it("rejects INSERT", () => {
    isUnsafe("INSERT INTO job_cards (id) VALUES ('x')")
  })

  it("rejects UPDATE", () => {
    isUnsafe("UPDATE job_cards SET status = 'closed'")
  })

  it("rejects DELETE", () => {
    isUnsafe("DELETE FROM job_cards")
  })

  it("rejects DROP / TRUNCATE / ALTER / CREATE", () => {
    isUnsafe("DROP TABLE job_cards")
    isUnsafe("TRUNCATE job_cards")
    isUnsafe("ALTER TABLE job_cards ADD COLUMN x text")
    isUnsafe("CREATE TABLE hack (id int)")
  })

  it("rejects GRANT / REVOKE", () => {
    isUnsafe("GRANT ALL ON job_cards TO public")
    isUnsafe("REVOKE ALL ON job_cards FROM public")
  })

  it("rejects a write statement stacked after a SELECT", () => {
    isUnsafe("SELECT 1; DELETE FROM job_cards")
  })

  it("rejects a write statement stacked before a SELECT", () => {
    isUnsafe("DELETE FROM job_cards; SELECT 1")
  })

  it("rejects a bare non-query statement", () => {
    isUnsafe("VACUUM job_cards")
    isUnsafe("CALL some_procedure()")
  })

  it("rejects an empty query", () => {
    isUnsafe("")
    isUnsafe("   ")
  })

  it("rejects anything not starting with SELECT/WITH", () => {
    isUnsafe("EXPLAIN SELECT * FROM job_cards")
  })
})
