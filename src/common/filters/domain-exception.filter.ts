import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { Prisma } from '@prisma/client'
import { AuthError, EmailInUseError, InvalidCredentialsError, InvalidTokenError } from '@spark/auth'
import {
  AccessCodeGenerationError,
  AnalyticsScopeForbiddenError,
  BookingNotFoundError,
  BookingStatusTransitionError,
  DefaultTariffRequiredError,
  DomainError,
  FacilityAlreadyExistsError,
  FacilityDeactivationFailedError,
  FacilityFieldForbiddenError,
  FacilityHasActiveBookingsError,
  FacilityNotBookableError,
  FacilityNotFoundError,
  IdempotencyConflictError,
  MixedCurrencyAnalyticsError,
  NoApplicableTariffError,
  NoAvailabilityError,
  OperatorContextRequiredError,
  OperatorSuspendedError,
  OperatorTargetRequiredError,
  QuoteExpiredError,
  RefundFailedError,
  TariffPlanNotFoundError,
} from '../errors/domain.errors'
import { AccountHasUnsettledBookingsError } from '../../auth/auth.types'
import {
  InviteAlreadyAcceptedError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteNotResendableError,
  InviteNotRevocableError,
} from '../../invite/invite.types'
import {
  LastOperatorAdminError,
  OperatorMemberNotFoundError,
  OperatorNotFoundError,
  OperatorNotReactivatableError,
  OperatorNotSuspendableError,
  SelfMembershipRemovalError,
  SelfRoleChangeError,
} from '../../operators/operators.types'

// Prisma's code for a transaction the database itself aborted: both 40001
// serialization_failure and 40P01 deadlock_detected surface under it.
const TRANSACTION_CONFLICT = 'P2034'

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const reply = ctx.getResponse<FastifyReply>()

    const { status, body } = this.resolve(exception)

    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception))
    }

    void reply.status(status).send(body)
  }

  private resolve(exception: unknown): { status: number; body: Record<string, unknown> } {
    if (exception instanceof HttpException) {
      const response = exception.getResponse()
      return {
        status: exception.getStatus(),
        body:
          typeof response === 'string'
            ? { message: response }
            : (response as Record<string, unknown>),
      }
    }

    const status = this.statusForDomainError(exception)
    if (status) {
      return { status, body: { message: (exception as Error).message } }
    }

    // 409, joining the other concurrency conflicts: the database aborted the transaction
    // because a competing one touched the same rows. Nothing the caller sent is wrong and
    // nothing was persisted, so the same request is expected to succeed on retry — 503
    // would misreport a per-request conflict as the whole service being down, which is
    // what sheds load balancers and trips circuit breakers. The message is ours, not
    // Prisma's — that one carries query internals.
    if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === TRANSACTION_CONFLICT
    ) {
      this.logger.warn(`Transaction aborted by the database (${TRANSACTION_CONFLICT})`)
      return {
        status: HttpStatus.CONFLICT,
        body: { message: 'Conflicting concurrent request. Please retry.' },
      }
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { message: 'Internal server error' },
    }
  }

  private statusForDomainError(exception: unknown): number | null {
    if (exception instanceof InvalidCredentialsError || exception instanceof InvalidTokenError) {
      return HttpStatus.UNAUTHORIZED
    }
    if (exception instanceof EmailInUseError) {
      return HttpStatus.CONFLICT
    }
    if (
      exception instanceof FacilityNotFoundError ||
      exception instanceof BookingNotFoundError ||
      exception instanceof TariffPlanNotFoundError ||
      exception instanceof InviteNotFoundError ||
      exception instanceof OperatorNotFoundError ||
      exception instanceof OperatorMemberNotFoundError
    ) {
      return HttpStatus.NOT_FOUND
    }
    if (
      exception instanceof OperatorContextRequiredError ||
      exception instanceof FacilityFieldForbiddenError ||
      exception instanceof OperatorSuspendedError ||
      exception instanceof AnalyticsScopeForbiddenError
    ) {
      return HttpStatus.FORBIDDEN
    }
    if (exception instanceof InviteExpiredError) {
      return HttpStatus.GONE
    }
    if (
      exception instanceof NoAvailabilityError ||
      exception instanceof FacilityNotBookableError ||
      exception instanceof QuoteExpiredError ||
      exception instanceof BookingStatusTransitionError ||
      exception instanceof IdempotencyConflictError ||
      exception instanceof DefaultTariffRequiredError ||
      exception instanceof FacilityAlreadyExistsError ||
      exception instanceof FacilityHasActiveBookingsError ||
      exception instanceof AccountHasUnsettledBookingsError ||
      exception instanceof InviteAlreadyAcceptedError ||
      exception instanceof InviteNotRevocableError ||
      exception instanceof InviteNotResendableError ||
      exception instanceof OperatorNotSuspendableError ||
      exception instanceof OperatorNotReactivatableError ||
      exception instanceof LastOperatorAdminError ||
      exception instanceof SelfRoleChangeError ||
      exception instanceof SelfMembershipRemovalError
    ) {
      return HttpStatus.CONFLICT
    }
    // 422: the request is well formed, but the data it selects cannot produce an answer.
    if (
      exception instanceof NoApplicableTariffError ||
      exception instanceof MixedCurrencyAnalyticsError
    ) {
      return HttpStatus.UNPROCESSABLE_ENTITY
    }
    // 502: the failure is the upstream payment provider's, and our own state is
    // consistent — the refund intent is recorded and the operation is retryable.
    if (
      exception instanceof RefundFailedError ||
      exception instanceof FacilityDeactivationFailedError
    ) {
      return HttpStatus.BAD_GATEWAY
    }
    // 503: nothing the caller sent is wrong and nothing was persisted; the same request
    // is expected to succeed on retry.
    if (exception instanceof AccessCodeGenerationError) {
      return HttpStatus.SERVICE_UNAVAILABLE
    }
    if (exception instanceof OperatorTargetRequiredError) {
      return HttpStatus.BAD_REQUEST
    }
    if (exception instanceof DomainError || exception instanceof AuthError) {
      return HttpStatus.BAD_REQUEST
    }
    return null
  }
}
