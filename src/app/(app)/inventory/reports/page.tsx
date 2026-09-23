import { requireAuth } from "@/lib/auth"
import { must } from "@/lib/db"
import { formatInr, formatQty } from "@/lib/format"
import { MaterialReportFilters } from "@/components/inventory/material-report-filters"
import { MaterialReportExportCsv } from "@/components/inventory/material-report-export-csv"
import { PrintButton } from "@/components/job-cards/print-button"

export const metadata = { title: "Material Report — ValveTrack" }

type LedgerRow = {
  id: string
  transaction_type: string
  qty: number
  unit_rate: number
  reference_type: string
  created_at: string
  item_master: { item_code: string; item_name: string; uom: string; consumable_type: string | null } | null
  storage_locations: { id: string; code: string } | null
}

type ItemSummary = {
  item_code: string
  item_name: string
  uom: string
  receivedQty: number
  issuedQty: number
  adjustedNetQty: number
  transferredQty: number
  netValue: number
}

/**
 * Client request: a printable material report for an arbitrary date range —
 * "from this date to this date." Reads directly from stock_ledger (the one
 * append-only source of truth every other stock figure in the app already
 * derives from — GRN receipts, issues, adjustments and transfers all post
 * there), so this can never disagree with Stock Balances or the Dashboard.
 */
export default async function MaterialReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; type?: string; location?: string; txn?: string }>
}) {
  const { supabase } = await requireAuth()
  const sp = await searchParams

  const today = new Date().toISOString().slice(0, 10)
  const firstOfMonth = `${today.slice(0, 7)}-01`
  const from = sp.from || firstOfMonth
  const to = sp.to || today
  const typeFilter = sp.type || "all"
  const locationFilter = sp.location || "all"
  const txnFilter = sp.txn || "all"

  const [ledgerRes, locationsRes] = await Promise.all([
    supabase
      .from("stock_ledger")
      .select("id, transaction_type, qty, unit_rate, reference_type, created_at, item_master(item_code, item_name, uom, consumable_type), storage_locations(id, code)")
      .gte("created_at", `${from}T00:00:00`)
      .lte("created_at", `${to}T23:59:59.999`)
      .order("created_at", { ascending: true })
      .limit(5000),
    supabase.from("storage_locations").select("id, code, name").eq("is_active", true).order("code"),
  ])

  const allRows = must(ledgerRes, "material ledger for this period") as unknown as LedgerRow[]
  const locations = must(locationsRes, "storage locations")

  // Filtering happens once, here, so the summary table, the transaction
  // detail table, the CSV export and the print view (which is just this same
  // page with window.print()) can never disagree about what "filtered" means.
  const rows = allRows.filter((r) => {
    if (typeFilter !== "all" && r.item_master?.consumable_type !== typeFilter) return false
    if (locationFilter !== "all" && r.storage_locations?.id !== locationFilter) return false
    if (txnFilter !== "all" && r.transaction_type !== txnFilter) return false
    return true
  })

  const activeFilterLabel = [
    typeFilter !== "all" ? `${typeFilter[0].toUpperCase()}${typeFilter.slice(1)}` : null,
    locationFilter !== "all" ? locations.find((l) => l.id === locationFilter)?.code : null,
    txnFilter !== "all" ? txnFilter.replace(/_/g, " ") : null,
  ].filter(Boolean).join(" · ")

  const summaryByItem = new Map<string, ItemSummary>()
  for (const r of rows) {
    if (!r.item_master) continue
    const key = r.item_master.item_code
    const existing = summaryByItem.get(key) ?? {
      item_code: r.item_master.item_code,
      item_name: r.item_master.item_name,
      uom: r.item_master.uom,
      receivedQty: 0, issuedQty: 0, adjustedNetQty: 0, transferredQty: 0, netValue: 0,
    }

    const signedQty = r.transaction_type.endsWith("_in") ? r.qty : -r.qty
    existing.netValue += signedQty * r.unit_rate

    if (r.transaction_type === "grn_in") existing.receivedQty += r.qty
    else if (r.transaction_type === "issue_out") existing.issuedQty += r.qty
    else if (r.reference_type === "transfer") existing.transferredQty += r.transaction_type === "adjustment_in" ? r.qty : -r.qty
    else existing.adjustedNetQty += signedQty

    summaryByItem.set(key, existing)
  }
  const summary = Array.from(summaryByItem.values()).sort((a, b) => a.item_code.localeCompare(b.item_code))
  const totalValue = summary.reduce((s, it) => s + it.netValue, 0)

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Material Report</h1>
          <p className="mt-1 text-sm text-muted-foreground">Stock movement for a chosen date range, printable.</p>
        </div>
        <div className="flex items-center gap-2">
          <MaterialReportExportCsv rows={rows} from={from} to={to} typeFilter={typeFilter} />
          <PrintButton label="Print Report" />
        </div>
      </div>

      <MaterialReportFilters
        from={from}
        to={to}
        typeFilter={typeFilter}
        locationFilter={locationFilter}
        txnFilter={txnFilter}
        locations={locations}
      />

      <header className="hidden border-b-2 border-foreground pb-3 print:block">
        <h1 className="text-xl font-semibold">MATERIAL REPORT</h1>
        <p className="text-sm text-muted-foreground">
          Raghav Engineering · {new Date(from).toLocaleDateString("en-IN")} to {new Date(to).toLocaleDateString("en-IN")}
          {activeFilterLabel && ` · ${activeFilterLabel}`}
        </p>
      </header>

      <p className="text-sm text-muted-foreground print:hidden">
        Showing {new Date(from).toLocaleDateString("en-IN")} to {new Date(to).toLocaleDateString("en-IN")}
        {activeFilterLabel && ` · ${activeFilterLabel}`}
        {" · "}{rows.length} ledger entries across {summary.length} items
      </p>

      {summary.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No stock movement in this period.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border print:border-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left text-xs uppercase tracking-wide text-muted-foreground print:bg-transparent">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Received</th>
                <th className="px-3 py-2 text-right font-medium">Issued</th>
                <th className="px-3 py-2 text-right font-medium">Adjusted (net)</th>
                <th className="px-3 py-2 text-right font-medium">Transferred (net)</th>
                <th className="px-3 py-2 text-right font-medium">Value Moved</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summary.map((it) => (
                <tr key={it.item_code}>
                  <td className="px-3 py-2">
                    <span className="font-medium">{it.item_code}</span>
                    <span className="ml-1.5 text-muted-foreground">{it.item_name}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-success">
                    {it.receivedQty > 0 ? `+${formatQty(it.receivedQty)} ${it.uom}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-danger">
                    {it.issuedQty > 0 ? `−${formatQty(it.issuedQty)} ${it.uom}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {it.adjustedNetQty !== 0 ? `${it.adjustedNetQty > 0 ? "+" : ""}${formatQty(it.adjustedNetQty)} ${it.uom}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {it.transferredQty !== 0 ? `${it.transferredQty > 0 ? "+" : ""}${formatQty(it.transferredQty)} ${it.uom}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{formatInr(it.netValue)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-secondary/40 font-semibold print:bg-transparent">
                <td className="px-3 py-2" colSpan={5}>Total Value Moved</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatInr(totalValue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-2 break-before-page">
          <h2 className="font-semibold print:hidden">Transaction Detail</h2>
          <div className="overflow-x-auto rounded-lg border border-border print:border-0">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-secondary/40 text-left uppercase tracking-wide text-muted-foreground print:bg-transparent">
                  <th className="px-3 py-1.5 font-medium">Date</th>
                  <th className="px-3 py-1.5 font-medium">Item</th>
                  <th className="px-3 py-1.5 font-medium">Location</th>
                  <th className="px-3 py-1.5 font-medium">Type</th>
                  <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                  <th className="px-3 py-1.5 text-right font-medium">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {new Date(r.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                    </td>
                    <td className="px-3 py-1.5">{r.item_master?.item_code ?? "—"}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{r.storage_locations?.code ?? "—"}</td>
                    <td className="px-3 py-1.5 capitalize text-muted-foreground">{r.transaction_type.replace(/_/g, " ")}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatQty(r.qty)} {r.item_master?.uom}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{formatInr(r.unit_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
