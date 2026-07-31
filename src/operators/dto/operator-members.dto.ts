import { OperatorMemberRole } from '@prisma/client'
import { z } from 'zod'

export const changeMemberRoleSchema = z.object({
  role: z.nativeEnum(OperatorMemberRole),
})

export type ChangeMemberRoleDto = z.infer<typeof changeMemberRoleSchema>
