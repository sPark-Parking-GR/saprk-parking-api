import type { AuthUser } from '@spark/types'
import type { FastifyRequest } from 'fastify'

export type AuthenticatedRequest = FastifyRequest & {
  user?: AuthUser
}
