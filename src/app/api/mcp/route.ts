import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { registerValveTrackTools } from "@/lib/mcp/tools"

/**
 * ValveTrack MCP server — lets Claude (Desktop and claude.ai/mobile, once
 * added as a custom connector) answer business questions against the live
 * database: "how many kg of X material moved in the last 3 months", stock
 * valuation, job/dispatch summaries, or open-ended analysis via a generic
 * read-only SQL tool.
 *
 * SETUP (do this once):
 *   1. Set MCP_READER_DATABASE_URL and MCP_ACCESS_TOKEN in this deployment's
 *      environment (see .env.example — generate your own values, never
 *      reuse an example). Redeploy after setting them.
 *   2. In Claude Desktop or claude.ai: Settings → Connectors → Add custom
 *      connector. URL: https://<your-domain>/api/mcp
 *      Header: Authorization: Bearer <your MCP_ACCESS_TOKEN>
 *   3. Ask it something. It can only ever read — see the "why this is safe"
 *      note below.
 *
 * WHY THIS IS SAFE TO EXPOSE:
 *   Every tool call, no matter what it does, ultimately runs through
 *   src/lib/mcp/db.ts, which connects using `mcp_reader` — a dedicated
 *   Postgres role with SELECT granted and NOTHING else (see
 *   supabase/migrations/0062). That was verified empirically, not just
 *   assumed from the grant statement: connected as the role directly and
 *   confirmed INSERT/UPDATE/DELETE/CREATE TABLE are all refused with
 *   "permission denied", before this route ever existed. A bug in this
 *   file's code, in the MCP SDK, or in whatever Claude decides to send
 *   cannot turn into a write — the database itself refuses it.
 *
 *   This route is the ONLY way in: a Bearer token check gates every
 *   request, independent of and in addition to the staff login system the
 *   rest of the app uses (Claude connects without a browser session, so it
 *   needs its own credential, not a cookie).
 *
 * Runs on the Node.js runtime, not Edge — the read-only Postgres connection
 * needs a real TCP socket, which Edge functions can't open.
 */
export const runtime = "nodejs"
export const maxDuration = 30

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
  })
}

function isAuthorized(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN
  if (!token) return false // fail closed — an unconfigured token means no one gets in, not everyone
  const header = req.headers.get("authorization") ?? ""
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return false
  return timingSafeEqual(match[1], token)
}

/** Avoids leaking the token's value through response-time differences. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Stateless mode, one MCP server + transport per request. There's no
 * session state worth sharing across invocations anyway — this is a
 * serverless function, a "persistent" server object wouldn't actually
 * persist between separate Lambda/Function invocations, so building for
 * statelessness up front is the only version of this that's actually
 * correct on Vercel.
 */
async function handle(req: Request): Promise<Response> {
  if (!isAuthorized(req)) return unauthorized()

  const server = new McpServer({ name: "valvetrack", version: "1.0.0" })
  registerValveTrackTools(server)

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — see note above
  })

  await server.connect(transport)
  return transport.handleRequest(req)
}

export const GET = handle
export const POST = handle
export const DELETE = handle
