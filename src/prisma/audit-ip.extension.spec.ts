import { PrismaClient } from '@prisma/client'
import { RequestContext } from '../common/context/request-context'
import { auditIpExtension } from './audit-ip.extension'

/**
 * The extension is the only thing stamping an IP onto the thirty-odd audited writes that
 * never set one themselves, so its two rules — fill when absent, never overwrite — are
 * asserted against a real extended client rather than a hand-rolled stub.
 */
describe('auditIpExtension', () => {
  function clientSpying(): { client: PrismaClient; created: jest.Mock } {
    const created = jest.fn().mockResolvedValue({ id: 'a1' })
    // The stamp is applied first so it sits OUTSIDE the recorder: the recorder answers
    // without a database and never delegates inward, so it has to be the last handler in
    // the chain or nothing else runs.
    const stamped = new PrismaClient().$extends(auditIpExtension)
    const spy = stamped.$extends({
      query: {
        auditLog: {
          create({ args }: { args: unknown }) {
            return created(args) as Promise<unknown>
          },
        },
      },
    })
    return { client: spy as unknown as PrismaClient, created }
  }

  const row = { actorId: 'u1', action: 'facility.created', entityType: 'Facility', entityId: 'f1' }

  it('stamps the request IP on an audit row that does not carry one', async () => {
    const { client, created } = clientSpying()

    // Awaited INSIDE the run callback, mirroring RequestContextInterceptor, which
    // subscribes to the whole handler chain from inside the scope. Returning the promise
    // instead would leave the scope before Prisma defers the extension handler.
    await RequestContext.run({ ip: '203.0.113.9' }, async () => {
      await client.auditLog.create({ data: { ...row } })
    })

    expect(created.mock.calls[0]![0].data.ipAddress).toBe('203.0.113.9')
  })

  it('leaves an explicitly supplied IP alone', async () => {
    const { client, created } = clientSpying()

    await RequestContext.run({ ip: '203.0.113.9' }, async () => {
      await client.auditLog.create({ data: { ...row, ipAddress: '198.51.100.1' } })
    })

    expect(created.mock.calls[0]![0].data.ipAddress).toBe('198.51.100.1')
  })

  it('writes no IP at all outside a request — a queue worker has none to claim', async () => {
    const { client, created } = clientSpying()

    await client.auditLog.create({ data: { ...row } })

    expect(created.mock.calls[0]![0].data.ipAddress).toBeUndefined()
  })
})
