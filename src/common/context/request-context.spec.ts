import { RequestContext } from './request-context'

describe('RequestContext', () => {
  it('returns null when read outside of any run() scope', () => {
    expect(RequestContext.getIp()).toBeNull()
  })

  it('exposes the ip for synchronous code inside run()', () => {
    RequestContext.run({ ip: '203.0.113.1' }, () => {
      expect(RequestContext.getIp()).toBe('203.0.113.1')
    })
  })

  it('exposes the ip across an await inside run()', async () => {
    await RequestContext.run({ ip: '203.0.113.2' }, async () => {
      await Promise.resolve()
      expect(RequestContext.getIp()).toBe('203.0.113.2')
    })
  })

  it('does not leak the ip to code outside the run() scope', async () => {
    await RequestContext.run({ ip: '203.0.113.3' }, async () => {
      await Promise.resolve()
    })
    expect(RequestContext.getIp()).toBeNull()
  })

  it('keeps concurrent run() scopes isolated from each other', async () => {
    const seenA: (string | null)[] = []
    const seenB: (string | null)[] = []

    await Promise.all([
      RequestContext.run({ ip: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 5))
        seenA.push(RequestContext.getIp())
      }),
      RequestContext.run({ ip: 'b' }, async () => {
        seenB.push(RequestContext.getIp())
      }),
    ])

    expect(seenA).toEqual(['a'])
    expect(seenB).toEqual(['b'])
  })
})
