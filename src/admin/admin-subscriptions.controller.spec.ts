import 'reflect-metadata'
import { RequestMethod } from '@nestjs/common'
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants'
import { PLATFORM_PERMISSIONS, type PlatformPermission } from '@spark/types'
import { PERMISSIONS_KEY } from '../auth/decorators/require-permission.decorator'
import { AdminSubscriptionsController } from './admin-subscriptions.controller'

type Handler = keyof AdminSubscriptionsController

interface RouteContract {
  handler: Handler
  method: RequestMethod
  path: string
}

/**
 * The frozen HTTP contract. Every route on this controller is gated on
 * `platform:billing.manage` and nothing else — transcribed here so a decorator dropped or
 * swapped for a broader permission in a refactor fails the build rather than quietly
 * handing pricing and entitlements to whoever holds tenant.write.
 */
const CONTRACT: RouteContract[] = [
  { handler: 'listPlans', method: RequestMethod.GET, path: 'plans' },
  { handler: 'createPlan', method: RequestMethod.POST, path: 'plans' },
  { handler: 'updatePlan', method: RequestMethod.PATCH, path: 'plans/:id' },
  { handler: 'archivePlan', method: RequestMethod.POST, path: 'plans/:id/archive' },
  { handler: 'getOperator', method: RequestMethod.GET, path: 'operators/:operatorId' },
  { handler: 'assign', method: RequestMethod.PUT, path: 'operators/:operatorId' },
  { handler: 'setOverride', method: RequestMethod.PUT, path: 'operators/:operatorId/override' },
]

function metadataFor(handler: Handler) {
  const fn = AdminSubscriptionsController.prototype[handler] as unknown as object
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

describe('AdminSubscriptionsController route contract', () => {
  it('mounts under the admin subscriptions prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminSubscriptionsController)).toBe(
      'admin/subscriptions',
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
    const handlers = Object.getOwnPropertyNames(AdminSubscriptionsController.prototype).filter(
      (name) => name !== 'constructor',
    )
    expect(handlers.sort()).toEqual(CONTRACT.map((route) => route.handler).sort())
    for (const handler of handlers) {
      expect(metadataFor(handler as Handler).permissions).toBeDefined()
    }
  })
})

describe('AdminSubscriptionsController permission separation', () => {
  // Billing is not implied by tenant administration. Today platform_admin happens to hold
  // every permission, so this separation is only visible at the metadata layer — which is
  // precisely why it is asserted here: the day a read-only support or tenant-admin role is
  // added to ROLE_PLATFORM_PERMISSIONS, these routes must not come with it.
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
