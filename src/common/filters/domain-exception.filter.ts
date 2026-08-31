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
  AlreadySubscribedToPlanError,
  AnalyticsScopeForbiddenError,
  ApprovalAlreadyPendingError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  BookingNotFoundError,
  BookingStatusTransitionError,
  DefaultSubscriptionPlanMissingError,
  DefaultTariffRequiredError,
  DomainError,
  EntitlementLimitExceededError,
  FacilityDeactivationFailedError,
  FacilityFieldForbiddenError,
  FacilityHasActiveBookingsError,
  FacilityHasNoOperatorError,
  FacilityKindChangeBlockedError,
  FacilityNotBookableError,
  FacilityNotFoundError,
  IdempotencyConflictError,
  LifecycleActionBlockedError,
  LifecycleResourceNotFoundError,
  LifecycleRestoreConflictError,
  LifecycleTransitionError,
  LiveSubscriptionNotFoundError,
  MixedCurrencyAnalyticsError,
  NoApplicableTariffError,
  NoAvailabilityError,
  OperatorContextRequiredError,
  OperatorHasActiveFacilitiesError,
  OperatorSuspendedError,
  OperatorTargetRequiredError,
  PurgeApproverUnavailableError,
  QuoteExpiredError,
  RefundFailedError,
  SelfApprovalError,
  SubscriptionDowngradeBlockedError,
  SubscriptionFeatureRequiredError,
  SubscriptionPlanCodeTakenError,
  SubscriptionPlanInUseError,
  SubscriptionPlanNotFoundError,
  TariffPlanNotFoundError,
  TicketNotFoundError,
  TicketNotIssuableError,
  TicketVerificationUnavailableError,
} from '../errors/domain.errors'
import { AccountHasUnsettledBookingsError } from '../../auth/auth.types'
import {
  InviteAlreadyAcceptedError,
  InviteEmailTakenError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteNotResendableError,
  InviteNotRevocableError,
} from '../../invite/invite.types'
import {
  AdminInviteAlreadyAcceptedError,
  AdminInviteEmailTakenError,
  AdminInviteExpiredError,
  AdminInviteNotFoundError,
  AdminInviteNotResendableError,
  AdminInviteNotRevocableError,
} from '../../identity/admin-invite.types'
import {
  AnonymisedAccountError,
  IdentityUserNotFoundError,
  LastSuperAdminError,
  NotASuperAdminError,
  SelfRoleAssignmentError,
  SuperAdminApproverUnavailableError,
  SuperAdminProtectedError,
} from '../../identity/identity.types'
import {
  AdminScopesNotEditableError,
  LastOperatorAdminError,
  OperatorMemberNotFoundError,
  OperatorNotFoundError,
  OperatorNotReactivatableError,
  OperatorNotVerifiableError,
  OperatorNotVerifiedError,
  OperatorEmailTakenError,
  SelfSignupDisabledError,
  OperatorNotSuspendableError,
  SelfMembershipRemovalError,
  SelfRoleChangeError,
} from '../../operators/operators.types'

// Prisma's code for a transaction the database itself aborted: both 40001
// serialization_failure and 40P01 deadlock_detected surface under it.
const TRANSACTION_CONFLICT = 'P2034'

// Shared with apps/web's invite-accept actions, which branch on it.
const EMAIL_TAKEN_CODE = 'EMAIL_TAKEN'
const ENTITLEMENT_LIMIT_CODE = 'ENTITLEMENT_LIMIT_EXCEEDED'
const FEATURE_REQUIRED_CODE = 'SUBSCRIPTION_FEATURE_REQUIRED'
// Fastify rejected the request envelope itself — unparseable or empty JSON body.
const MALFORMED_REQUEST_CODE = 'MALFORMED_REQUEST'

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

  /**
   * Fastify raises its own errors before any Nest layer sees the request — an empty body or
   * malformed JSON under `Content-Type: application/json` being the common pair. They are
   * plain Errors, not HttpExceptions, so they fell through to the generic 500 branch: a
   * caller who sent a bad request was told the server had broken, and the 500 branch logged
   * a stack for it. They already carry the right status; this honours it.
   *
   * Narrowed to 4xx on purpose. A Fastify error reporting 5xx really is ours, and must keep
   * its stack in the log rather than being quietly reclassified as the client's fault.
   */
  private fastifyClientError(exception: unknown): { status: number; message: string } | null {
    if (!(exception instanceof Error)) return null
    const candidate = exception as Error & { code?: unknown; statusCode?: unknown }
    if (typeof candidate.code !== 'string' || !candidate.code.startsWith('FST_ERR_')) return null
    if (typeof candidate.statusCode !== 'number') return null
    if (candidate.statusCode < 400 || candidate.statusCode >= 500) return null
    return { status: candidate.statusCode, message: candidate.message }
  }

  private resolve(exception: unknown): { status: number; body: Record<string, unknown> } {
    const fastifyError = this.fastifyClientError(exception)
    if (fastifyError) {
      return {
        status: fastifyError.status,
        body: { message: fastifyError.message, code: MALFORMED_REQUEST_CODE },
      }
    }

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

    // The blocker list travels with the refusal so the client can render the same
    // {code, message, remedy} triples the /impact dry run showed, without a second call.
    if (exception instanceof LifecycleActionBlockedError) {
      return {
        status: HttpStatus.CONFLICT,
        body: { message: exception.message, blockers: exception.blockers },
      }
    }

    // Same shape as the lifecycle blocker list above, and for the same reason: the refusal
    // has to be renderable as the exact cleanup the operator must perform, without a
    // second call to work out which limits are breached and by how much.
    if (exception instanceof SubscriptionDowngradeBlockedError) {
      return {
        status: HttpStatus.CONFLICT,
        body: { message: exception.message, violations: exception.violations },
      }
    }

    // Both of these are 409, and an invite-accept client can do nothing useful with that
    // number alone: "this link was already redeemed" and "this address already has an
    // account" are opposite situations with opposite remedies. The code travels with the
    // refusal so the accept page states the right one instead of guessing.
    if (
      exception instanceof InviteEmailTakenError ||
      exception instanceof AdminInviteEmailTakenError ||
      exception instanceof EmailInUseError
    ) {
      return {
        status: HttpStatus.CONFLICT,
        body: { message: exception.message, code: EMAIL_TAKEN_CODE },
      }
    }

    // Plan refusals carry the same kind of code as EMAIL_TAKEN above, and for the same
    // reason: "you are out of facilities" and "your plan does not include this" are
    // different remedies sharing a status with every other refusal on the endpoint. Both
    // errors already hold the parts a client needs to render an upgrade prompt — resource,
    // limit, current / feature — and dropping them forced the web app to recognise a plan
    // limit by regex-matching the English sentence, which any copy edit would have broken.
    if (exception instanceof EntitlementLimitExceededError) {
      return {
        status: HttpStatus.CONFLICT,
        body: {
          message: exception.message,
          code: ENTITLEMENT_LIMIT_CODE,
          resource: exception.resource,
          limit: exception.limit,
          current: exception.current,
        },
      }
    }
    if (exception instanceof SubscriptionFeatureRequiredError) {
      return {
        status: HttpStatus.FORBIDDEN,
        body: {
          message: exception.message,
          code: FEATURE_REQUIRED_CODE,
          feature: exception.feature,
        },
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
    if (
      exception instanceof FacilityNotFoundError ||
      exception instanceof BookingNotFoundError ||
      exception instanceof TariffPlanNotFoundError ||
      exception instanceof InviteNotFoundError ||
      exception instanceof OperatorNotFoundError ||
      exception instanceof OperatorMemberNotFoundError ||
      exception instanceof IdentityUserNotFoundError ||
      exception instanceof AdminInviteNotFoundError ||
      exception instanceof TicketNotFoundError ||
      exception instanceof LifecycleResourceNotFoundError ||
      exception instanceof ApprovalNotFoundError ||
      exception instanceof SubscriptionPlanNotFoundError ||
      exception instanceof LiveSubscriptionNotFoundError
    ) {
      return HttpStatus.NOT_FOUND
    }
    if (
      exception instanceof OperatorContextRequiredError ||
      exception instanceof FacilityFieldForbiddenError ||
      exception instanceof OperatorSuspendedError ||
      exception instanceof AnalyticsScopeForbiddenError ||
      exception instanceof SelfApprovalError ||
      exception instanceof SelfSignupDisabledError ||
      // 403 rather than 409: nothing about the request conflicts with current state, the
      // caller simply has not bought the capability. Retrying it unchanged never succeeds.
      exception instanceof SubscriptionFeatureRequiredError
    ) {
      return HttpStatus.FORBIDDEN
    }
    if (
      exception instanceof InviteExpiredError ||
      exception instanceof AdminInviteExpiredError ||
      exception instanceof ApprovalExpiredError
    ) {
      return HttpStatus.GONE
    }
    if (
      exception instanceof NoAvailabilityError ||
      exception instanceof FacilityNotBookableError ||
      exception instanceof QuoteExpiredError ||
      exception instanceof BookingStatusTransitionError ||
      exception instanceof IdempotencyConflictError ||
      exception instanceof DefaultTariffRequiredError ||
      exception instanceof EntitlementLimitExceededError ||
      exception instanceof SubscriptionPlanCodeTakenError ||
      exception instanceof AlreadySubscribedToPlanError ||
      exception instanceof SubscriptionPlanInUseError ||
      exception instanceof FacilityHasActiveBookingsError ||
      exception instanceof FacilityHasNoOperatorError ||
      exception instanceof FacilityKindChangeBlockedError ||
      exception instanceof AccountHasUnsettledBookingsError ||
      exception instanceof InviteAlreadyAcceptedError ||
      exception instanceof InviteNotRevocableError ||
      exception instanceof InviteNotResendableError ||
      exception instanceof OperatorNotSuspendableError ||
      exception instanceof OperatorNotReactivatableError ||
      exception instanceof OperatorNotVerifiableError ||
      exception instanceof OperatorNotVerifiedError ||
      exception instanceof OperatorEmailTakenError ||
      exception instanceof LastOperatorAdminError ||
      exception instanceof SelfRoleChangeError ||
      exception instanceof AdminScopesNotEditableError ||
      exception instanceof SelfRoleAssignmentError ||
      exception instanceof AdminInviteAlreadyAcceptedError ||
      exception instanceof AdminInviteNotResendableError ||
      exception instanceof AdminInviteNotRevocableError ||
      exception instanceof AnonymisedAccountError ||
      exception instanceof SuperAdminProtectedError ||
      exception instanceof LastSuperAdminError ||
      exception instanceof NotASuperAdminError ||
      exception instanceof SuperAdminApproverUnavailableError ||
      exception instanceof SelfMembershipRemovalError ||
      exception instanceof TicketNotIssuableError ||
      exception instanceof LifecycleTransitionError ||
      exception instanceof LifecycleRestoreConflictError ||
      exception instanceof LifecycleActionBlockedError ||
      exception instanceof OperatorHasActiveFacilitiesError ||
      exception instanceof PurgeApproverUnavailableError ||
      exception instanceof ApprovalNotPendingError ||
      exception instanceof ApprovalAlreadyPendingError
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
    if (
      exception instanceof AccessCodeGenerationError ||
      exception instanceof TicketVerificationUnavailableError ||
      exception instanceof DefaultSubscriptionPlanMissingError
    ) {
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
