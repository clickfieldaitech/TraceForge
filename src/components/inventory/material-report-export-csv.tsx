"use client"

import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"

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

function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Exports exactly the rows the page already filtered server-side (same
 * `rows` prop that drives the on-screen tables) — never re-derives or
 * re-fetches, so this can't drift from what's shown on screen or on print.
 */
export function MaterialReportExportCsv({
  rows,
  from,
  to,
  typeFilter,
}: {
  rows: LedgerRow[]
  from: string
  to: string
  typeFilter: string
}) {
  function exportCsv() {
    const header = ["Date", "Item Code", "Item Name", "Type", "Location", "Transaction", "Qty", "UOM", "Rate", "Value"]
    const lines = [header.join(",")]
    for (const r of rows) {
      const value = (r.transaction_type.endsWith("_in") ? r.qty : -r.qty) * r.unit_rate
      lines.push([
        new Date(r.created_at).toLocaleDateString("en-IN"),
        r.item_master?.item_code ?? "",
        r.item_master?.item_name ?? "",
        r.item_master?.consumable_type ?? "",
        r.storage_locations?.code ?? "",
        r.transaction_type.replace(/_/g, " "),
        r.qty,
        r.item_master?.uom ?? "",
        r.unit_rate,
        value.toFixed(2),
      ].map(csvEscape).join(","))
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    const suffix = typeFilter === "all" ? "" : `-${typeFilter}`
    a.download = `material-report${suffix}-${from}-to-${to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
      <Download className="mr-1.5 h-4 w-4" /> Export Excel
    </Button>
  )
}
