import 'reflect-metadata'
import { RequestMethod } from '@nestjs/common'
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants'
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants'
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator'
import { PERMISSIONS_KEY } from '../auth/decorators/require-permission.decorator'
import { DriverMockCheckoutController } from './driver-mock-checkout.controller'
import { DriverSubscriptionsSelfController } from './driver-subscriptions-self.controller'
import { DriverSubscriptionsWebhookController } from './driver-subscriptions-webhook.controller'
import {
  CHECKOUT_CANCEL_URL,
  CHECKOUT_SUCCESS_URL,
} from './driver-subscriptions-self.service'

function metadataFor(prototype: object, handler: string) {
  const fn = (prototype as Record<string, unknown>)[handler] as object
  return {
    path: Reflect.getMetadata(PATH_METADATA, fn) as string,
    method: Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod,
    isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, fn) as boolean | undefined,
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, fn) as string[] | undefined,
    throttleLimit: Reflect.getMetadata(`${THROTTLER_LIMIT}default`, fn) as number | undefined,
    throttleTtl: Reflect.getMetadata(`${THROTTLER_TTL}default`, fn) as number | undefined,
  }
}

const SELF = DriverSubscriptionsSelfController.prototype

/**
 * AuthGuard is global and refuses every request that carries no user unless the handler is
 * marked @Public. That inverts the usual reading of these assertions: `isPublic` undefined
 * IS the authentication requirement, and a stray @Public on `me` or `checkout` would open a
 * rider's own billing data to anyone. The metadata is asserted here so that change fails the
 * build rather than a code review.
 */
describe('DriverSubscriptionsSelfController route contract', () => {
  it('mounts on the rider prefix, not under admin', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DriverSubscriptionsSelfController)).toBe(
      'driver-subscriptions',
    )
  })

  it('leaves the plan catalog open — it carries published prices and nothing personal', () => {
    const actual = metadataFor(SELF, 'listPlans')
    expect(actual.path).toBe('plans')
    expect(actual.method).toBe(RequestMethod.GET)
    expect(actual.isPublic).toBe(true)
  })

  it.each([
    ['me', RequestMethod.GET, 'me'],
    ['checkout', RequestMethod.POST, 'checkout'],
  ])('requires authentication on %s', (handler, method, path) => {
    const actual = metadataFor(SELF, handler)
    expect(actual.path).toBe(path)
    expect(actual.method).toBe(method)
    expect(actual.isPublic).toBeUndefined()
  })

  // Every call reaches an external billing provider and may mint a customer there, so it is
  // held well below the global 120/min — the same order as the other money-adjacent routes.
  it('throttles checkout below the global default', () => {
    const actual = metadataFor(SELF, 'checkout')
    expect(actual.throttleLimit).toBe(20)
    expect(actual.throttleTtl).toBe(60_000)
  })

  // These are rider-facing. A platform permission here would be a copy-paste from the admin
  // controller and would lock every actual rider out.
  it('carries no platform permission on any handler', () => {
    for (const handler of ['listPlans', 'me', 'checkout']) {
      expect(metadataFor(SELF, handler).permissions).toBeUndefined()
    }
  })

  it('exposes exactly three handlers', () => {
    expect(
      Object.getOwnPropertyNames(SELF)
        .filter((name) => name !== 'constructor')
        .sort(),
    ).toEqual(['checkout', 'listPlans', 'me'])
  })
})

/**
 * The mobile app is already built against these two strings and cannot be changed to match a
 * new one; a rider whose checkout returns to an unrecognised URL is simply stranded on the
 * payment page.
 */
describe('driver checkout return URLs', () => {
  it('are the fixed mobile contract, not derived from anything a caller sends', () => {
    expect(CHECKOUT_SUCCESS_URL).toBe('spark://subscription-return?status=success')
    expect(CHECKOUT_CANCEL_URL).toBe('spark://subscription-return?status=cancel')
  })
})

describe('DriverSubscriptionsWebhookController route contract', () => {
  it('is public and posts to its own path, separate from the payments webhook', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DriverSubscriptionsWebhookController)).toBe(
      'driver-subscriptions',
    )
    const actual = metadataFor(DriverSubscriptionsWebhookController.prototype, 'handle')
    expect(actual.path).toBe('webhook')
    expect(actual.method).toBe(RequestMethod.POST)
    // A provider cannot present a bearer token; the signature is the credential.
    expect(actual.isPublic).toBe(true)
  })
})

describe('DriverMockCheckoutController route contract', () => {
  it('mounts under the rider prefix so the mock provider’s generated URL resolves', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DriverMockCheckoutController)).toBe(
      'driver-subscriptions/mock-checkout',
    )
  })

  it.each([
    ['show', RequestMethod.GET, ':sessionId'],
    ['confirm', RequestMethod.POST, ':sessionId/confirm'],
    ['cancel', RequestMethod.POST, ':sessionId/cancel'],
  ])('exposes %s publicly — the page is reached from an external browser', (handler, method, path) => {
    const actual = metadataFor(DriverMockCheckoutController.prototype, handler)
    expect(actual.path).toBe(path)
    expect(actual.method).toBe(method)
    expect(actual.isPublic).toBe(true)
  })
})
