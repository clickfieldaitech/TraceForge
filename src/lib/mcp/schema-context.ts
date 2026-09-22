/**
 * Business/schema context handed to Claude via the `get_schema_context` tool
 * and referenced in the server's own instructions. This is the single
 * highest-leverage piece for "answer correctly" — without it, an LLM writing
 * ad hoc SQL against a 43-table schema will get plausible-looking column
 * names and semantics wrong in ways that are hard to notice from the answer
 * alone (e.g. summing a column that's always positive without accounting
 * for direction, or forgetting a soft-delete filter).
 *
 * Every fact below was pulled from the live schema (information_schema,
 * pg_constraint) while this was written — not from memory or assumption.
 * If the schema changes, this drifts and needs updating alongside it.
 */
export const SCHEMA_CONTEXT = `
# ValveTrack database — read-only reference for analysis

You are answering business questions for the owner of Raghav Engineering, a
valve/pressure-part welding and fabrication job-shop. All amounts are in INR.
This connection is genuinely read-only at the database level (a dedicated
Postgres role with SELECT-only grants) — you cannot write no matter what SQL
you send, so there is no need to hedge or ask permission before querying;
just query, and be precise about what the numbers mean.

## The big picture
- \`job_cards\` is the hub: one row per physical part/order moving through the
  shop, from receipt to dispatch.
- \`stock_ledger\` is the SINGLE SOURCE OF TRUTH for all inventory movement —
  every other stock figure (stock_balances view, dashboards) derives from it.
  Never trust a running total anywhere else over this table.
- Money/quantity questions ("kg of X sold/used in 3 months") almost always
  mean querying \`stock_ledger\` joined to \`item_master\`, not the job_cards
  table.

## stock_ledger — the critical table for material/quantity questions
Columns: id, item_id, storage_location_id, transaction_type, qty,
reference_type, reference_id, unit_rate, created_by, created_at.

**qty is ALWAYS POSITIVE** (CHECK qty > 0). Direction comes from
\`transaction_type\`, not the sign of qty. To compute net movement:
  SUM(CASE WHEN transaction_type LIKE '%_in' THEN qty ELSE -qty END)

transaction_type is one of exactly: 'grn_in', 'issue_out', 'adjustment_in',
'adjustment_out'. There is no 'transfer_in'/'transfer_out' — a stock
TRANSFER between locations is posted as one adjustment_out + one
adjustment_in pair, distinguished from a real manual correction only by
reference_type = 'transfer' (vs reference_type = 'adjustment' for an actual
stock adjustment). Both legs of a transfer are valued at the source
location's current weighted-average cost, so transfers never change total
inventory value — only where it sits.

reference_type is one of: 'grn' (material received & QC-accepted),
'material_issue' (consumed on a job), 'adjustment' (manual correction),
'transfer' (location-to-location move, see above).

unit_rate is the value that row was posted at (weighted-average cost at
that moment) — NOT a fixed standard cost. Stock value = SUM(qty * unit_rate)
with the same in/out sign convention as above.

Practical translations:
- "kg of <item> issued/used/sold in the last 3 months" →
  reference_type across grn/material_issue is what you want:
  SUM(qty) WHERE transaction_type='issue_out' AND item matches AND
  created_at >= now() - interval '3 months'
  ("sold" in this business usually means dispatched-as-part-of-a-job, i.e.
  consumed via issue_out on a job card that later dispatched — issue_out
  quantity is the right proxy unless the question is really about dispatched
  finished valves, which is job_cards/dispatches, a different question.)
- "current stock of <item>" → the stock_balances view (below), or
  SUM with the in/out sign convention on stock_ledger up to now.
- "material received this month" → transaction_type='grn_in'.

## stock_balances (VIEW, not a table)
Columns: item_id, storage_location_id, balance_qty, balance_value,
avg_unit_cost. Pre-aggregated current position per item per location,
derived from stock_ledger. Fast for "what do we have right now," but for
any DATE-RANGE question go to stock_ledger directly — this view has no
history.

## item_master — what a "material" actually is
Columns: id, item_code, item_name, category, uom, hsn_code,
min_stock_level, description, is_active, consumable_type, approval_status,
kg_per_unit, created_by/at, updated_at.
- category ∈ raw_material | consumable | component | finished_part | other
- consumable_type ∈ powder | rod | wire | other (welding consumables only;
  NULL for everything else)
- approval_status ∈ pending | approved | rejected — an item can exist but
  not yet be approved for use; check this if stock numbers look surprising.
- item_code is the human-facing code people actually say out loud (e.g.
  "RM-C-0008") — match on item_code OR item_name for a natural-language
  material reference, case-insensitively (ILIKE), since users rarely type
  the exact stored casing.

## job_cards — the shop-floor unit of work
Key columns: id, jc_number, client_id, nbdn_number, po_number, description,
drawing_number, heat_number, part_number, quantity, process_type (array),
received_date, status, stage_entered_at, due_date, tags (array),
created_at/by, deleted_at/deleted_by/purge_at (soft delete — ALWAYS filter
\`deleted_at IS NULL\` unless the question is specifically about deleted/
recycle-bin jobs).

status is a strict 14-state lifecycle, enforced at the database level (a
job literally cannot skip a stage): created → wps_pending → wps_uploaded →
wps_approved → process_assigned → in_process → process_complete →
reports_pending → reports_complete → dispatch_ready → dispatched →
accounts_processing → closed. Plus a parallel 'on_hold' state a job can
enter from anywhere. "Active" jobs = status <> 'closed' (and deleted_at IS
NULL). "Overdue" = due_date < current_date AND status not in a
terminal/near-terminal state.

process_type is an ARRAY (e.g. weld/machining/cladding/overlay can all
apply to one job) — use \`process_type @> ARRAY['welding']\` or
\`'welding' = ANY(process_type)\` style matching, not \`=\`.

## Money — accounts, dispatches
\`dispatches\`: one row per shipment out (dc_number, dispatch_date,
vehicle/driver/transporter details, lr_number) linked to job_card_id.
\`accounts\`: invoicing/payment per job_card_id — po_value, invoice_number/
date/value, payment_status, payment_date, payment_amount, due_date,
grn_status (customer's own GRN acknowledgement), tally_reference. Multiple
rows can exist per job if invoiced/paid in parts — sum, don't assume 1:1.
"Revenue/sales in period X" → SUM(invoice_value) or SUM(payment_amount)
from accounts filtered on invoice_date/payment_date, joined to job_cards
for client name — invoice_value is what was billed, payment_amount is what
actually came in; these can differ (partial payment, disputes).

## Clients vs suppliers vs users — don't conflate these
- \`clients\`: the companies Raghav Engineering does job-work FOR (their
  customers). job_cards.client_id points here.
- \`suppliers\`: companies Raghav Engineering BUYS consumables/raw material
  FROM. material_inward.supplier_id points here (when source_type='supplier').
- material_inward can ALSO originate directly from a client's own supplied
  material (source_type='customer', client_id set instead of supplier_id —
  CHECK constraint enforces exactly one of the two is set).
- \`profiles\`: internal staff AND external portal-customer logins, in one
  table. role ∈ admin|operator|engineer|qa|accounts|management|customer.
  A 'customer' role row always has client_id set (CHECK constraint); every
  other role always has client_id NULL. Don't confuse profiles.client_id
  (a portal login's own company) with clients (the company records
  themselves) — profiles.client_id is a foreign key into clients.

## Inspection / compliance tables (one row per report, per job_card_id)
wps_master (approval workflow: draft|approved|superseded — this is the
welding-procedure MASTER, separate from wps_qualifications which links a
specific job to one), pmi_reports (pmi_status), dimension_reports
(dimension_status), overlay_welding_reports (report_status), pwht_runs
(approval_status: draft|submitted|approved|rejected; pwht_result: pass|fail;
this is heat-treatment cycle data with a generated chart, not a document),
rework_records, air_test_records, nde_records, quality_inspections
(incoming-material QC, separate from the outgoing inspection reports above).
customer_dossiers bundles several of these into one submission package per
job — status field, submitted_to_customer boolean.

## Audit trail
\`audit_log\`: entity_type, entity_id, action (INSERT/UPDATE/DELETE),
old_value/new_value (full-row JSONB before/after), performed_by,
performed_at. Covers job_cards, accounts, dispatches, wps_qualifications,
profiles, and the various *_master tables — a generic trigger, not
hand-written per table, so coverage is consistent. Use this for "who
changed X and when" questions; old_value/new_value are the actual row
contents, so e.g. \`old_value->>'status'\` gets a job's prior status.

## Common mistakes to avoid
- Don't sum stock_ledger.qty without the in/out CASE — it is never negative,
  so a naive SUM wildly overstates movement.
- Don't answer "current stock" from stock_ledger by summing everything ever
  without the sign convention either — same issue, and slower than just
  using the stock_balances view.
- Don't forget \`deleted_at IS NULL\` on job_cards unless asked about deleted
  ones specifically — soft-deleted rows are still physically present.
- item_code/item_name matching should be case-insensitive (ILIKE '%...%')
  — people write "RMC0008", "RM-C-0008", "rm-c-0008" interchangeably.
- Dates: received_date/due_date/dispatch_date/invoice_date are DATE (no
  time component); created_at/updated_at/stage_entered_at are full
  timestamptz. Don't mix them in the same comparison without casting.

## How to work
1. If a question is about a specific business concept you're not certain
   how to compute correctly from the above, say so explicitly rather than
   guessing — a wrong number stated confidently is worse than admitting
   uncertainty and showing the query you ran so it can be checked.
2. Prefer the purpose-built tools (material_movement, stock_valuation,
   job_card_summary, dispatch_summary) for the questions they cover — they
   encode the sign conventions and filters above correctly by construction.
   Fall back to the generic \`query\` tool for anything else.
3. When you do write raw SQL, show it in your answer (briefly) so a mistake
   is checkable, not just the final number.
4. Every read-only query result greater than 500 rows is truncated —
   aggregate in SQL (GROUP BY / SUM) rather than pulling raw rows and
   summing client-side, both for correctness and because raw rows may be
   cut off before you see the whole picture.
`.trim()
