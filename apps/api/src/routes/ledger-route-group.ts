import type { Hono } from 'hono'
import type { AppBindings } from '../http.js'
import { registerLedgerRoutes, type LedgerRouteDeps } from '../ledger/routes.js'
import { registerReconciliationRoutes } from '../ledger/reconciliation-routes.js'
import { registerSettlementPartyRoutes } from '../ledger/settlement-party-routes.js'
import { registerSettlementCandidateRoutes } from '../ledger/settlement-candidate-routes.js'
import { registerSettlementRuleRoutes } from '../ledger/settlement-rule-routes.js'
import { registerSettlementStatementRoutes } from '../ledger/settlement-statement-routes.js'

/**
 * Ledger + settlement route assembly (LL-MVP-008, Issue #64).
 *
 * `app.ts` still decides *where* this group is mounted — after the local order
 * routes, because ledger facts are derived from them — and what dependencies it
 * injects. This module owns only the order *inside* the group, so the rationale
 * lives next to the calls it constrains.
 *
 * Reconciliation is registered **before** the read-only ledger skeleton on
 * purpose: Hono matches in registration order, and the skeleton owns read-only
 * GETs of some of the same paths. Registering the concrete module first means
 * its derivation wins instead of being shadowed.
 */
export function registerLedgerRouteGroup(
  app: Hono<AppBindings>,
  deps: LedgerRouteDeps,
): void {
  registerReconciliationRoutes(app, deps)

  // Ledger skeleton: read-only views over facts projected from the order,
  // verification and reward sources.
  registerLedgerRoutes(app, deps)

  // Offline settlement surfaces (#183/#187 and the contract rule versions).
  registerSettlementPartyRoutes(app, deps)
  registerSettlementCandidateRoutes(app, deps)
  registerSettlementRuleRoutes(app, deps)
  registerSettlementStatementRoutes(app, deps)
}
