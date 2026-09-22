import { Prisma } from '@prisma/client'
import { RequestContext } from '../common/context/request-context'

/**
 * Stamps the inbound request's IP onto every AuditLog row that does not already carry one.
 *
 * The column has been on the model from the start, but only the invite and admin-invite
 * services ever set it — every other audited write (facility created, tariff plan updated,
 * booking cancelled, member role changed) landed with a null `ipAddress`. That is the one
 * field an audit trail cannot reconstruct after the fact, and it was missing from precisely
 * the actions an investigation would care about. Thirty-nine call sites across twenty-three
 * services is too many to keep correct by hand, and a forgotten one is silent, so the rule
 * lives in one place that no writer can skip.
 *
 * DOES NOT OVERWRITE an explicit value: a caller that knows better than the ambient context
 * — replaying an event, attributing an action to where it truly came from — keeps its own.
 *
 * WHERE IT DOES NOT APPLY, all correctly:
 * - Work with no inbound request: queue processors, cron, webhook replays outside a request
 *   scope. RequestContext.getIp() answers null there, and a null IP is the honest record.
 * - Raw SQL. No code path writes AuditLog through $executeRaw.
 * - createMany. Audit rows are written one per action; adding it would mean rewriting an
 *   array of payloads for a shape nothing produces.
 */
export const auditIpExtension = Prisma.defineExtension({
  name: 'audit-ip',
  query: {
    auditLog: {
      create({ args, query }) {
        if (args.data.ipAddress === undefined || args.data.ipAddress === null) {
          const ip = RequestContext.getIp()
          if (ip !== null) {
            args.data = { ...args.data, ipAddress: ip }
          }
        }
        return query(args)
      },
    },
  },
})
