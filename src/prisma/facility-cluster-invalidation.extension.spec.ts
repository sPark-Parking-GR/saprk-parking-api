import { getFacilityClusterIndexVersion } from '../facilities/facility-cluster-invalidation'
import { facilityClusterInvalidationExtension } from './facility-cluster-invalidation.extension'

interface AllOperationsArgs {
  model?: string
  operation: string
  args: unknown
  query: (args: unknown) => Promise<unknown>
}
type AllOperationsHandler = (params: AllOperationsArgs) => Promise<unknown>

// Prisma.defineExtension only hands back its query handlers once applied to a real client
// via $extends (see prisma.service.ts); there is no live client in a unit test. A stub
// client whose $extends just returns the extension args it was given is enough to recover
// the raw $allOperations handler in isolation — the client-extension equivalent of how
// lifecycle.extension.spec.ts unit-tests withLifecycleFilter without a live client.
function allOperationsHandler(): AllOperationsHandler {
  const stubClient = {
    $extends: (extArgs: { query: { $allOperations: AllOperationsHandler } }) => extArgs,
  }
  return (
    facilityClusterInvalidationExtension as unknown as (client: typeof stubClient) => {
      query: { $allOperations: AllOperationsHandler }
    }
  )(stubClient).query.$allOperations
}

const FACILITY_WRITE_OPERATIONS = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]

// The bump is debounced (see facility-cluster-invalidation.ts), so every assertion here
// advances past the window; a pending timer is drained before the clock is restored, or it
// would swallow the next test's invalidation.
const DEBOUNCE_MS = 1_000

describe('facilityClusterInvalidationExtension', () => {
  const handler = allOperationsHandler()

  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it.each(FACILITY_WRITE_OPERATIONS)(
    'invalidates the cluster index after a successful Facility %s',
    async (operation) => {
      const before = getFacilityClusterIndexVersion()
      const query = jest.fn().mockResolvedValue({ id: 'f1' })

      const result = await handler({ model: 'Facility', operation, args: { data: {} }, query })
      jest.advanceTimersByTime(DEBOUNCE_MS)

      expect(query).toHaveBeenCalledWith({ data: {} })
      expect(result).toEqual({ id: 'f1' })
      expect(getFacilityClusterIndexVersion()).toBe(before + 1)
    },
  )

  it('costs a single version bump for a bulk burst of writes', async () => {
    const before = getFacilityClusterIndexVersion()
    const query = jest.fn().mockResolvedValue({ id: 'f1' })

    for (let i = 0; i < 1_000; i += 1) {
      await handler({ model: 'Facility', operation: 'update', args: {}, query })
    }
    jest.advanceTimersByTime(DEBOUNCE_MS)

    expect(query).toHaveBeenCalledTimes(1_000)
    expect(getFacilityClusterIndexVersion()).toBe(before + 1)
  })

  it('leaves a write on a different model alone', async () => {
    const before = getFacilityClusterIndexVersion()
    const query = jest.fn().mockResolvedValue({ id: 'b1' })

    const result = await handler({ model: 'Booking', operation: 'create', args: {}, query })
    jest.advanceTimersByTime(DEBOUNCE_MS)

    expect(result).toEqual({ id: 'b1' })
    expect(getFacilityClusterIndexVersion()).toBe(before)
  })

  it('does not invalidate on a Facility read', async () => {
    const before = getFacilityClusterIndexVersion()
    const query = jest.fn().mockResolvedValue([])

    await handler({ model: 'Facility', operation: 'findMany', args: {}, query })
    jest.advanceTimersByTime(DEBOUNCE_MS)

    expect(getFacilityClusterIndexVersion()).toBe(before)
  })

  it('propagates a rejected write without invalidating', async () => {
    const before = getFacilityClusterIndexVersion()
    const failure = new Error('write failed')
    const query = jest.fn().mockRejectedValue(failure)

    await expect(handler({ model: 'Facility', operation: 'update', args: {}, query })).rejects.toBe(
      failure,
    )
    jest.advanceTimersByTime(DEBOUNCE_MS)

    expect(getFacilityClusterIndexVersion()).toBe(before)
  })
})
