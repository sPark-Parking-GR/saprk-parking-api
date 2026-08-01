import 'reflect-metadata'
import { RequestMethod } from '@nestjs/common'
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants'
import { PLATFORM_PERMISSIONS, type PlatformPermission } from '@spark/types'
import { PERMISSIONS_KEY } from '../auth/decorators/require-permission.decorator'
import { AdminLifecycleController } from './admin-lifecycle.controller'

type Handler = keyof AdminLifecycleController

interface RouteContract {
  handler: Handler
  method: RequestMethod
  path: string
  permission: PlatformPermission
}

/**
 * The frozen HTTP contract, transcribed once. Every row is checked against the metadata the
 * controller actually carries, so a decorator dropped or downgraded in a refactor fails
 * here rather than silently widening who may destroy a tenant.
 */
const CONTRACT: RouteContract[] = [
  {
    handler: 'trash',
    method: RequestMethod.GET,
    path: 'trash',
    permission: 'platform:tenant.read',
  },
  {
    handler: 'impact',
    method: RequestMethod.GET,
    path: ':resourceType/:id/impact',
    permission: 'platform:tenant.read',
  },
  {
    handler: 'archive',
    method: RequestMethod.POST,
    path: ':resourceType/:id/archive',
    permission: 'platform:tenant.write',
  },
  {
    handler: 'restore',
    method: RequestMethod.POST,
    path: ':resourceType/:id/restore',
    permission: 'platform:tenant.write',
  },
  {
    handler: 'tombstone',
    method: RequestMethod.POST,
    path: ':resourceType/:id/tombstone',
    permission: 'platform:tenant.purge',
  },
  {
    handler: 'purge',
    method: RequestMethod.POST,
    path: ':resourceType/:id/purge',
    permission: 'platform:tenant.purge',
  },
  {
    handler: 'approvals',
    method: RequestMethod.GET,
    path: 'approvals',
    permission: 'platform:tenant.purge',
  },
  {
    handler: 'approve',
    method: RequestMethod.POST,
    path: 'approvals/:id/approve',
    permission: 'platform:tenant.purge',
  },
  {
    handler: 'reject',
    method: RequestMethod.POST,
    path: 'approvals/:id/reject',
    permission: 'platform:tenant.purge',
  },
]

function metadataFor(handler: Handler) {
  const fn = AdminLifecycleController.prototype[handler] as unknown as object
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

describe('AdminLifecycleController route contract', () => {
  it('mounts under the admin lifecycle prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminLifecycleController)).toBe('admin/lifecycle')
  })

  it.each(CONTRACT.map((route) => [`${route.handler} ${route.path}`, route] as const))(
    '%s is exposed exactly as the contract states',
    (_name, route) => {
      const actual = metadataFor(route.handler)
      expect(actual.path).toBe(route.path)
      expect(actual.method).toBe(route.method)
      expect(actual.permissions).toEqual([route.permission])
    },
  )

  it('leaves no handler ungated', () => {
    const handlers = Object.getOwnPropertyNames(AdminLifecycleController.prototype).filter(
      (name) => name !== 'constructor',
    )
    expect(handlers.sort()).toEqual(CONTRACT.map((route) => route.handler).sort())
    for (const handler of handlers) {
      expect(metadataFor(handler as Handler).permissions).toBeDefined()
    }
  })
})

describe('AdminLifecycleController permission tiers', () => {
  const readAndWrite = new Set<PlatformPermission>([
    'platform:tenant.read',
    'platform:tenant.write',
  ])
  const everything = new Set<PlatformPermission>(PLATFORM_PERMISSIONS)

  const destructive = CONTRACT.filter((route) => route.permission === 'platform:tenant.purge')

  it('covers every destructive endpoint', () => {
    expect(destructive.map((route) => route.handler)).toEqual([
      'tombstone',
      'purge',
      'approvals',
      'approve',
      'reject',
    ])
  })

  it.each(destructive.map((route) => [route.handler, route] as const))(
    'refuses %s to a caller holding tenant.write but not tenant.purge',
    (_name, route) => {
      const required = metadataFor(route.handler).permissions ?? []
      expect(admits(readAndWrite, required)).toBe(false)
      expect(admits(everything, required)).toBe(true)
    },
  )

  it('still admits that same caller to the reversible endpoints', () => {
    for (const handler of ['trash', 'impact', 'archive', 'restore'] as const) {
      expect(admits(readAndWrite, metadataFor(handler).permissions ?? [])).toBe(true)
    }
  })
})
