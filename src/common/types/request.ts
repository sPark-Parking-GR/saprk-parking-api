import type { AuthUser } from '@parqin/types'
import type { FastifyRequest } from 'fastify'

export type AuthenticatedRequest = FastifyRequest & {
  user?: AuthUser
}
