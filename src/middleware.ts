import { type NextRequest, NextResponse } from "next/server"
import { updateSession } from "@/lib/supabase/middleware"
import { checkRateLimit } from "@/lib/rate-limit"

const IS_DEV = process.env.NODE_ENV !== "production"

// Login: relaxed in dev for quick-switching between test accounts
const LOGIN_LIMIT = IS_DEV ? 100 : 5
const LOGIN_WINDOW_MS = 60 * 1000

// General API
const API_LIMIT = IS_DEV ? 1000 : 100
const API_WINDOW_MS = 60 * 1000

// Heavy PDF/ZIP generation endpoints
const GENERATE_LIMIT = IS_DEV ? 100 : 10
const GENERATE_WINDOW_MS = 60 * 60 * 1000

function getIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  )
}

function rateLimitResponse(resetAt: number): NextResponse {
  const retryAfter = Math.ceil((resetAt - Date.now()) / 1000)
  return new NextResponse("Too many requests. Please try again later.", {
    status: 429,
    headers: {
      "Retry-After": String(retryAfter),
      "X-RateLimit-Limit": String(LOGIN_LIMIT),
    },
  })
}

// The MCP server (Claude-as-PA) is a machine-to-machine endpoint with its
// own independent Bearer-token auth (checked inside the route handler
// itself, against MCP_ACCESS_TOKEN) — it never has a Supabase session
// cookie, and its caller is an MCP client, not a browser page served by
// this app. Two things below would otherwise break it if left to apply
// here: the CSRF origin check (an MCP client sends no Origin/Referer
// matching this app's own URL — it isn't one), and updateSession (which
// redirects an unauthenticated request to /login, turning every tool call
// into a 307 instead of a JSON-RPC response). The general API rate limit
// still applies below — that's good hygiene, not a browser-session concern.
const isMcpRoute = (pathname: string) => pathname.startsWith("/api/mcp")

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const method = request.method
  const ip = getIp(request)

  // ── Login endpoint: strict limit ─────────────────────────────────────────
  if (pathname.startsWith("/login")) {
    const { allowed, resetAt } = await checkRateLimit(`login:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS)
    if (!allowed) return rateLimitResponse(resetAt)
  }

  // ── PDF/ZIP generation endpoints: very strict limit ──────────────────────
  const isGenerateRoute = /^\/api\/(pmi-reports|dimension-reports|overlay-reports|dossiers)\/[^/]+\/generate$/.test(pathname)
  if (isGenerateRoute && method === "POST") {
    const { allowed, resetAt } = await checkRateLimit(`generate:${ip}`, GENERATE_LIMIT, GENERATE_WINDOW_MS)
    if (!allowed) return rateLimitResponse(resetAt)
  }

  // ── General API / app limit ──────────────────────────────────────────────
  if (pathname.startsWith("/api")) {
    const { allowed, resetAt } = await checkRateLimit(`api:${ip}`, API_LIMIT, API_WINDOW_MS)
    if (!allowed) return rateLimitResponse(resetAt)
  }

  if (isMcpRoute(pathname)) {
    return NextResponse.next()
  }

  // ── CSRF: reject state-mutating requests from foreign origins ────────────
  const safeMethods = ["GET", "HEAD", "OPTIONS"]
  if (!safeMethods.includes(method) && pathname.startsWith("/api")) {
    const origin = request.headers.get("origin")
    const referer = request.headers.get("referer")
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""

    if (appUrl && (origin ?? referer)) {
      try {
        const expectedHost = new URL(appUrl).host
        const candidateHost = new URL(origin ?? referer ?? "").host
        if (candidateHost !== expectedHost) {
          return new NextResponse("Forbidden", { status: 403 })
        }
      } catch {
        // Malformed origin/referer header — block it
        return new NextResponse("Forbidden", { status: 403 })
      }
    }
  }

  return updateSession(request)
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
