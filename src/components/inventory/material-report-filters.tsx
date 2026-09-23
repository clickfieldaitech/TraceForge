"use client"

import { useState } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Button } from "@/components/ui/button"

const TXN_TYPES = [
  { value: "all", label: "All transaction types" },
  { value: "grn_in", label: "GRN In" },
  { value: "issue_out", label: "Issue Out" },
  { value: "adjustment_in", label: "Adjustment In" },
  { value: "adjustment_out", label: "Adjustment Out" },
]

/**
 * All filters live in the URL (searchParams), not client state — the report
 * page reads them server-side to build the summary/detail tables, so this
 * one set of filters drives the on-screen view, the printed view (just
 * window.print() on the same page) and the CSV export identically. No
 * separate "export filters" to keep in sync with "screen filters."
 */
export function MaterialReportFilters({
  from,
  to,
  typeFilter,
  locationFilter,
  txnFilter,
  locations,
}: {
  from: string
  to: string
  typeFilter: string
  locationFilter: string
  txnFilter: string
  locations: { id: string; code: string; name: string }[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [fromDate, setFromDate] = useState(from)
  const [toDate, setToDate] = useState(to)
  const [type, setType] = useState(typeFilter)
  const [location, setLocation] = useState(locationFilter)
  const [txn, setTxn] = useState(txnFilter)

  function apply() {
    const params = new URLSearchParams(searchParams.toString())
    params.set("from", fromDate)
    params.set("to", toDate)
    params.set("type", type)
    params.set("location", location)
    params.set("txn", txn)
    router.push(`${pathname}?${params.toString()}`)
  }

  function reset() {
    setFromDate(from)
    setToDate(to)
    setType("all")
    setLocation("all")
    setTxn("all")
    router.push(pathname)
  }

  return (
    <div className="flex flex-wrap items-end gap-3 print:hidden">
      <div>
        <Label className="text-xs">From</Label>
        <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="mt-1" />
      </div>
      <div>
        <Label className="text-xs">To</Label>
        <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="mt-1" />
      </div>
      <div>
        <Label className="text-xs">Material Type</Label>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="mt-1">
          <option value="all">All types</option>
          <option value="wire">Wire</option>
          <option value="rod">Rod</option>
          <option value="powder">Powder</option>
        </Select>
      </div>
      <div>
        <Label className="text-xs">Location</Label>
        <Select value={location} onChange={(e) => setLocation(e.target.value)} className="mt-1">
          <option value="all">All locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
          ))}
        </Select>
      </div>
      <div>
        <Label className="text-xs">Transaction</Label>
        <Select value={txn} onChange={(e) => setTxn(e.target.value)} className="mt-1">
          {TXN_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </Select>
      </div>
      <Button size="sm" onClick={apply}>Apply</Button>
      <Button size="sm" variant="outline" onClick={reset}>Reset</Button>
    </div>
  )
}
