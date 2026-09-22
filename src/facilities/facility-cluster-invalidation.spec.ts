import {
  getFacilityClusterIndexVersion,
  invalidateFacilityClusterIndex,
} from './facility-cluster-invalidation'

// The counter is a process-global singleton (see the module's own doc comment), so these
// assertions are all RELATIVE to whatever other spec files in this worker already bumped
// it to — never against an assumed absolute starting value.
describe('facility-cluster-invalidation', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  // The debounce handle is module-global too: a pending timer left un-fired when the clock
  // is restored would swallow every later invalidation in this file.
  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it('does not bump the version synchronously', () => {
    const before = getFacilityClusterIndexVersion()

    invalidateFacilityClusterIndex()

    expect(getFacilityClusterIndexVersion()).toBe(before)
  })

  it('increments the version by exactly 1 once the debounce window elapses', () => {
    const before = getFacilityClusterIndexVersion()

    invalidateFacilityClusterIndex()
    jest.advanceTimersByTime(1_000)

    expect(getFacilityClusterIndexVersion()).toBe(before + 1)
  })

  it('collapses a burst of calls inside one window into a single increment', () => {
    const before = getFacilityClusterIndexVersion()

    for (let i = 0; i < 500; i += 1) invalidateFacilityClusterIndex()
    jest.advanceTimersByTime(1_000)

    expect(getFacilityClusterIndexVersion()).toBe(before + 1)
  })

  it('fires on the trailing edge of the first call, without a later call extending it', () => {
    const before = getFacilityClusterIndexVersion()

    invalidateFacilityClusterIndex()
    jest.advanceTimersByTime(900)
    invalidateFacilityClusterIndex()
    jest.advanceTimersByTime(100)

    expect(getFacilityClusterIndexVersion()).toBe(before + 1)
  })

  it('increments again for a call arriving after the previous window fired', () => {
    const before = getFacilityClusterIndexVersion()

    invalidateFacilityClusterIndex()
    jest.advanceTimersByTime(1_000)
    invalidateFacilityClusterIndex()
    jest.advanceTimersByTime(1_000)

    expect(getFacilityClusterIndexVersion()).toBe(before + 2)
  })

  it('leaves the version unchanged when not called', () => {
    const before = getFacilityClusterIndexVersion()

    jest.advanceTimersByTime(5_000)

    expect(getFacilityClusterIndexVersion()).toBe(before)
  })
})
