import type { AuthJsCreateUserInput, AuthJsUserRecord, AuthJsUserStore } from '@spark/auth'
import type { UserRole as ContractRole } from '@spark/types'
import { UserRole } from '@prisma/client'
import type { PrismaService } from '../prisma/prisma.service'

const TO_PRISMA: Record<ContractRole, UserRole> = {
  guest: UserRole.USER,
  user: UserRole.USER,
  operator_staff: UserRole.OPERATOR_STAFF,
  operator_admin: UserRole.OPERATOR_ADMIN,
  platform_admin: UserRole.PLATFORM_ADMIN,
}

const FROM_PRISMA: Record<UserRole, ContractRole> = {
  [UserRole.USER]: 'user',
  [UserRole.OPERATOR_STAFF]: 'operator_staff',
  [UserRole.OPERATOR_ADMIN]: 'operator_admin',
  [UserRole.PLATFORM_ADMIN]: 'platform_admin',
}

interface UserRow {
  id: string
  email: string
  role: UserRole
  emailVerified: boolean
  displayName: string | null
  avatarUrl: string | null
  passwordHash: string | null
  firebaseUid: string | null
}

export class PrismaAuthJsUserStore implements AuthJsUserStore {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<AuthJsUserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { email } })
    return user ? this.toRecord(user) : null
  }

  async findById(id: string): Promise<AuthJsUserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { id } })
    return user ? this.toRecord(user) : null
  }

  async createUser(input: AuthJsCreateUserInput): Promise<AuthJsUserRecord> {
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        role: TO_PRISMA[input.role],
        displayName: input.displayName ?? null,
        firebaseUid: input.firebaseUid ?? null,
      },
    })
    return this.toRecord(user)
  }

  async deleteUser(id: string): Promise<void> {
    await this.prisma.user.delete({ where: { id } })
  }

  private toRecord(user: UserRow): AuthJsUserRecord {
    return {
      id: user.id,
      email: user.email,
      role: FROM_PRISMA[user.role],
      emailVerified: user.emailVerified,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      passwordHash: user.passwordHash ?? '',
      firebaseUid: user.firebaseUid,
    }
  }
}
