import { ForbiddenException } from '@nestjs/common'
import type { AuthUser } from '@spark/types'
import { AnalyticsController } from './analytics.controller'
import type { AnalyticsService } from './analytics.service'

const from = new Date('2026-07-01T00:00:00Z')
const to = new Date('2026-08-01T00:00:00Z')

function setup() {
  const analytics = {
    summary: jest.fn().mockResolvedValue({}),
    revenueSeries: jest.fn().mockResolvedValue({}),
    topFacilities: jest.fn().mockResolvedValue({}),
  }
  return {
    analytics,
    controller: new AnalyticsController(analytics as unknown as AnalyticsService),
  }
}

describe('AnalyticsController authorization', () => {
  // The RolesGuard is metadata-driven and global; this asserts the controller refuses on
  // its own, so dropping the decorator cannot silently open the routes.
  it.each(['user', 'consumer'] as const)(
    'refuses a %s role even without the guard',
    async (role) => {
      const { controller, analytics } = setup()
      const user = { id: 'u1', role } as unknown as AuthUser

      expect(() => controller.summary({ from, to }, user)).toThrow(ForbiddenException)
      expect(() => controller.revenueSeries({ from, to, bucket: 'day' }, user)).toThrow(
        ForbiddenException,
      )
      expect(() => controller.topFacilities({ from, to, limit: 10 }, user)).toThrow(
        ForbiddenException,
      )
      expect(analytics.summary).not.toHaveBeenCalled()
    },
  )

  it.each(['operator_staff', 'operator_admin', 'platform_admin'] as const)(
    'passes a %s through to the service',
    async (role) => {
      const { controller, analytics } = setup()
      const user = { id: 'u1', role } as AuthUser

      await controller.summary({ from, to }, user)
      await controller.revenueSeries({ from, to, bucket: 'week' }, user)
      await controller.topFacilities({ from, to, limit: 5 }, user)

      expect(analytics.summary).toHaveBeenCalledWith(user, { from, to })
      expect(analytics.revenueSeries).toHaveBeenCalledWith(user, { from, to, bucket: 'week' })
      expect(analytics.topFacilities).toHaveBeenCalledWith(user, { from, to, limit: 5 })
    },
  )
})
