import { HttpStatus } from '@nestjs/common'
import type { ArgumentsHost } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { DomainExceptionFilter } from './domain-exception.filter'
import {
  AccessCodeGenerationError,
  DomainError,
  FacilityDeactivationFailedError,
  FacilityHasActiveBookingsError,
  FacilityHasNoOperatorError,
  FacilityKindChangeBlockedError,
  FacilityNotBookableError,
} from '../errors/domain.errors'
import { EmailInUseError } from '@spark/auth'
import { InviteAlreadyAcceptedError, InviteEmailTakenError } from '../../invite/invite.types'
import { AdminInviteEmailTakenError } from '../../identity/admin-invite.types'

function makeHost(): { host: ArgumentsHost; reply: { status: jest.Mock; send: jest.Mock } } {
  const reply = { status: jest.fn(), send: jest.fn() }
  reply.status.mockReturnValue(reply)
  const host = {
    switchToHttp: () => ({ getResponse: () => reply }),
  } as unknown as ArgumentsHost
  return { host, reply }
}

describe('DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter

  beforeEach(() => {
    filter = new DomainExceptionFilter()
  })

  it('maps FacilityNotBookableError to 409, grouped with other hold-time state conflicts', () => {
    const { host, reply } = makeHost()

    filter.catch(new FacilityNotBookableError('f1'), host)

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.CONFLICT)
  })

  it('maps a plain DomainError to 400', () => {
    const { host, reply } = makeHost()

    filter.catch(new DomainError('endsAt must be after startsAt'), host)

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST)
  })

  it('maps FacilityHasActiveBookingsError to 409 — a refusable state conflict', () => {
    const { host, reply } = makeHost()

    filter.catch(new FacilityHasActiveBookingsError('f1', 3), host)

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.CONFLICT)
  })

  it('maps FacilityKindChangeBlockedError to 409, alongside the other booking-state refusals', () => {
    const { host, reply } = makeHost()

    filter.catch(new FacilityKindChangeBlockedError('f1', 'FREE_PUBLIC', 2), host)

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.CONFLICT)
  })

  it('maps FacilityHasNoOperatorError to 409 — a resource-state refusal, not bad input', () => {
    const { host, reply } = makeHost()

    filter.catch(new FacilityHasNoOperatorError('f1'), host)

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.CONFLICT)
  })

  it('maps FacilityDeactivationFailedError to 502, like any other refund-path failure', () => {
    const { host, reply } = makeHost()

    filter.catch(new FacilityDeactivationFailedError('f1', 2, 1), host)

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.BAD_GATEWAY)
  })

  it('maps AccessCodeGenerationError to 503, not to a client error', () => {
    const { host, reply } = makeHost()

    filter.catch(new AccessCodeGenerationError(5), host)

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE)
  })

  it('maps a P2034 transaction abort to 409 without echoing Prisma internals', () => {
    const { host, reply } = makeHost()

    filter.catch(
      new Prisma.PrismaClientKnownRequestError('could not serialize access to "Booking"', {
        code: 'P2034',
        clientVersion: '6.0.0',
      }),
      host,
    )

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.CONFLICT)
    expect(reply.send).toHaveBeenCalledWith({
      message: 'Conflicting concurrent request. Please retry.',
    })
  })

  it('still maps an unrecognized raw Error to 500 (no silent regression)', () => {
    const { host, reply } = makeHost()

    filter.catch(new Error('boom'), host)

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR)
  })

  /**
   * The two 409s an invite-accept client can receive are opposites — "this link was already
   * redeemed" versus "this address already has an account" — and the status alone cannot
   * separate them. Collapsing them is how a live invite to a re-registering address was
   * reported as a reused one, complete with a sign-in link to an account that no longer
   * existed. The code is the contract apps/web branches on, so it is asserted literally.
   */
  it.each([
    ['InviteEmailTakenError', new InviteEmailTakenError('owner@biz.com')],
    ['AdminInviteEmailTakenError', new AdminInviteEmailTakenError('admin@biz.com')],
    ['EmailInUseError', new EmailInUseError()],
  ])('tags %s as a 409 the client can tell apart', (_name, error) => {
    const { host, reply } = makeHost()

    filter.catch(error, host)

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.CONFLICT)
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EMAIL_TAKEN' }),
    )
  })

  it('leaves a genuinely-reused invite untagged, so it reads as the other conflict', () => {
    const { host, reply } = makeHost()

    filter.catch(new InviteAlreadyAcceptedError(), host)

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.CONFLICT)
    expect(reply.send).toHaveBeenCalledWith(expect.not.objectContaining({ code: 'EMAIL_TAKEN' }))
  })

})
