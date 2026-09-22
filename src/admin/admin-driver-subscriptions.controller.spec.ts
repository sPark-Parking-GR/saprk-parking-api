import 'reflect-metadata'
import { RequestMethod } from '@nestjs/common'
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants'
import { PLATFORM_PERMISSIONS, type PlatformPermission } from '@spark/types'
import { PERMISSIONS_KEY } from '../auth/decorators/require-permission.decorator'
import { AdminDriverSubscriptionsController } from './admin-driver-subscriptions.controller'

type Handler = keyof AdminDriverSubscriptionsController

interface RouteContract {
  handler: Handler
  method: RequestMethod
  path: string
}

/**
 * The frozen HTTP contract, transcribed for the same reason the operator controller's is:
 * a decorator dropped or swapped for a broader permission in a refactor must fail the build
 * rather than quietly hand rider pricing to whoever holds tenant.write.
 */
const CONTRACT: RouteContract[] = [
  { handler: 'listPlans', method: RequestMethod.GET, path: 'plans' },
  { handler: 'createPlan', method: RequestMethod.POST, path: 'plans' },
  { handler: 'updatePlan', method: RequestMethod.PATCH, path: 'plans/:id' },
  { handler: 'archivePlan', method: RequestMethod.POST, path: 'plans/:id/archive' },
  { handler: 'getDriver', method: RequestMethod.GET, path: 'users/:userId' },
  { handler: 'assign', method: RequestMethod.PUT, path: 'users/:userId' },
  { handler: 'setOverride', method: RequestMethod.PUT, path: 'users/:userId/override' },
]

function metadataFor(handler: Handler) {
  const fn = AdminDriverSubscriptionsController.prototype[handler] as unknown as object
  return {
    path: Reflect.getMetadata(PATH_METADATA, fn) as string,
    method: Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod,
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, fn) as PlatformPermission[] | undefined,
  }
}

// PermissionGuard's own rule, replicated so this spec measures the declared metadata by
// exactly the test the guard applies at runtime.
function admits(held: ReadonlySet<PlatformPermission>, required: PlatformPermission[]): boolean {
  return required.every((permission) => held.has(permission))
}

describe('AdminDriverSubscriptionsController route contract', () => {
  it('mounts under its own prefix, separate from the operator catalog', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminDriverSubscriptionsController)).toBe(
      'admin/driver-subscriptions',
    )
  })

  it.each(CONTRACT.map((route) => [`${route.handler} ${route.path}`, route] as const))(
    '%s is exposed exactly as the contract states, gated on billing.manage',
    (_name, route) => {
      const actual = metadataFor(route.handler)
      expect(actual.path).toBe(route.path)
      expect(actual.method).toBe(route.method)
      expect(actual.permissions).toEqual(['platform:billing.manage'])
    },
  )

  it('leaves no handler ungated', () => {
    const handlers = Object.getOwnPropertyNames(
      AdminDriverSubscriptionsController.prototype,
    ).filter((name) => name !== 'constructor')
    expect(handlers.sort()).toEqual(CONTRACT.map((route) => route.handler).sort())
    for (const handler of handlers) {
      expect(metadataFor(handler as Handler).permissions).toBeDefined()
    }
  })
})

describe('AdminDriverSubscriptionsController permission separation', () => {
  const tenantAdmin = new Set<PlatformPermission>([
    'platform:tenant.read',
    'platform:tenant.write',
    'platform:tenant.purge',
  ])
  const billing = new Set<PlatformPermission>(['platform:billing.manage'])
  const everything = new Set<PlatformPermission>(PLATFORM_PERMISSIONS)

  it.each(CONTRACT.map((route) => [route.handler, route] as const))(
    'refuses %s to a caller holding tenant.write but not billing.manage',
    (_name, route) => {
      const required = metadataFor(route.handler).permissions
      expect(required).toBeDefined()
      expect(admits(tenantAdmin, required as PlatformPermission[])).toBe(false)
    },
  )

  // Reading a rider's plan is not identity administration: it says what was bought, not who
  // bought it, so it must not drag in the identity:* family that separates the admin tiers.
  it.each(CONTRACT.map((route) => [route.handler, route] as const))(
    'admits %s to a caller holding billing.manage alone',
    (_name, route) => {
      expect(admits(billing, metadataFor(route.handler).permissions as PlatformPermission[])).toBe(
        true,
      )
    },
  )

  it.each(CONTRACT.map((route) => [route.handler, route] as const))(
    'admits %s to a full platform administrator',
    (_name, route) => {
      expect(
        admits(everything, metadataFor(route.handler).permissions as PlatformPermission[]),
      ).toBe(true)
    },
  )
})
