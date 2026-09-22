import { Logger } from '@nestjs/common'
import type { EmailContext, PushContext } from '@spark/notifications'
import { NotificationsService } from './notifications.service'
import type { PrismaService } from '../prisma/prisma.service'

const BOOKING_DATA = {
  bookingId: 'bk_1',
  accessCode: '1234',
  facilityName: 'Syntagma Garage',
  startsAt: new Date(),
  endsAt: new Date(),
  amountCents: 500,
  currency: 'EUR',
  recipientEmail: 'driver@example.com',
  recipientUserId: 'user-1',
}

describe('NotificationsService', () => {
  let send: jest.Mock
  let pushSend: jest.Mock
  let mobileProfileFindUnique: jest.Mock
  let service: NotificationsService
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    send = jest.fn()
    pushSend = jest.fn().mockResolvedValue(undefined)
    mobileProfileFindUnique = jest.fn().mockResolvedValue(null)
    const prisma = { mobileProfile: { findUnique: mobileProfileFindUnique } }
    service = new NotificationsService(
      { send } as unknown as EmailContext,
      { send: pushSend } as unknown as PushContext,
      prisma as unknown as PrismaService,
    )
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('logs a static message with structured fields instead of interpolating the failure', async () => {
    send.mockRejectedValue(new Error('socket hang up'))

    await service.sendBookingConfirmation(BOOKING_DATA)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const [payload, message] = errorSpy.mock.calls[0] as [Record<string, unknown>, string]
    expect(message).toBe('Failed to send notification')
    expect(payload).toEqual({ kind: 'confirmation', bookingId: 'bk_1', error: 'socket hang up' })
  })

  it('never puts a recipient address embedded in an ESP error message into the log', async () => {
    send.mockRejectedValue(
      new Error('Bad Request: to email address jane.doe@example.com is invalid'),
    )

    await service.sendPasswordReset({
      to: 'jane.doe@example.com',
      resetLink: 'https://app.spark.example/reset?token=super-secret-token',
    })

    const [payload] = errorSpy.mock.calls[0] as [Record<string, unknown>]
    expect(JSON.stringify(payload)).not.toContain('jane.doe@example.com')
    expect(payload.error).toBe('Bad Request: to email address [REDACTED] is invalid')
  })

  it('never logs the raw single-use token carried by an invite accept URL', async () => {
    send.mockRejectedValue(new Error('rejected'))

    await service.sendOperatorInvite({
      to: 'owner@example.com',
      acceptUrl: 'https://app.spark.example/invite/accept?token=abc123secret',
    })

    const [payload] = errorSpy.mock.calls[0] as [Record<string, unknown>]
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('abc123secret')
    expect(serialized).not.toContain('owner@example.com')
  })

  it('never logs the raw single-use token carried by a password reset link', async () => {
    send.mockRejectedValue(new Error('rejected'))

    await service.sendPasswordReset({
      to: 'driver@example.com',
      resetLink: 'https://app.spark.example/reset?token=reset-secret-token',
    })

    const [payload] = errorSpy.mock.calls[0] as [Record<string, unknown>]
    expect(JSON.stringify(payload)).not.toContain('reset-secret-token')
  })

  it('keeps swallowing password reset delivery failures (uniform 204 response contract)', async () => {
    send.mockRejectedValue(new Error('boom'))

    await expect(
      service.sendPasswordReset({ to: 'a@b.com', resetLink: 'https://x/reset?token=t' }),
    ).resolves.toBeUndefined()
  })

  it('still reports delivery outcome for operator invites', async () => {
    send.mockRejectedValueOnce(new Error('boom'))
    send.mockResolvedValueOnce(undefined)

    await expect(
      service.sendOperatorInvite({
        to: 'owner@example.com',
        acceptUrl: 'https://app.spark.example/invite/accept?token=abc123secret',
      }),
    ).resolves.toBe(false)

    await expect(
      service.sendOperatorInvite({
        to: 'owner@example.com',
        acceptUrl: 'https://app.spark.example/invite/accept?token=abc123secret',
      }),
    ).resolves.toBe(true)
  })

  describe('sendBookingConfirmationPush', () => {
    it('sends when the recipient has a push token on file', async () => {
      mobileProfileFindUnique.mockResolvedValue({ pushToken: 'ExponentPushToken[abc]' })

      await expect(service.sendBookingConfirmationPush(BOOKING_DATA)).resolves.toBe(true)

      expect(mobileProfileFindUnique).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: { pushToken: true },
      })
      expect(pushSend).toHaveBeenCalledWith({
        to: 'ExponentPushToken[abc]',
        title: 'Booking confirmed',
        body: expect.stringContaining('Syntagma Garage'),
        data: { type: 'booking', bookingId: 'bk_1' },
      })
    })

    it('no-ops without error when there is no MobileProfile row', async () => {
      mobileProfileFindUnique.mockResolvedValue(null)

      await expect(service.sendBookingConfirmationPush(BOOKING_DATA)).resolves.toBe(true)
      expect(pushSend).not.toHaveBeenCalled()
    })

    it('no-ops without error when the profile has no push token', async () => {
      mobileProfileFindUnique.mockResolvedValue({ pushToken: null })

      await expect(service.sendBookingConfirmationPush(BOOKING_DATA)).resolves.toBe(true)
      expect(pushSend).not.toHaveBeenCalled()
    })

    it('reports failure the same way email delivery does, without throwing', async () => {
      mobileProfileFindUnique.mockResolvedValue({ pushToken: 'ExponentPushToken[abc]' })
      pushSend.mockRejectedValue(new Error('Expo push rejected: DeviceNotRegistered'))

      await expect(service.sendBookingConfirmationPush(BOOKING_DATA)).resolves.toBe(false)
      expect(errorSpy).toHaveBeenCalledTimes(1)
    })
  })
})
