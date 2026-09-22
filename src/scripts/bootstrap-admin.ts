import { randomBytes } from 'node:crypto'
import { PrismaClient, UserRole } from '@prisma/client'
import { hashPassword } from '@spark/auth'
import { z } from 'zod'

const PASSWORD_BYTES = 24

export class BootstrapAdminRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BootstrapAdminRefusedError'
  }
}

export interface BootstrapAdminUserInput {
  email: string
  displayName: string | null
  passwordHash: string
  role: UserRole
  emailVerified: boolean
}

// Deliberately has no membership method: a super admin is global, never scoped to an
// operator, so the port makes an operator membership unrepresentable rather than merely
// unused.
export interface BootstrapAdminStore {
  countSuperAdmins(): Promise<number>
  findUserByEmail(email: string): Promise<{ id: string; role: UserRole } | null>
  createUser(input: BootstrapAdminUserInput): Promise<{ id: string }>
}

export interface BootstrapAdminResult {
  id: string
  email: string
  password: string
}

export function generatePassword(): string {
  return randomBytes(PASSWORD_BYTES).toString('base64url')
}

// Narrow schema of its own rather than src/config/env.schema.ts: that schema describes
// what the API server needs to boot (Firebase, maps, payments, CORS…), none of which
// this command touches. Reusing it would force an operator to assemble the full runtime
// secret set on whatever host runs the bootstrap, for no security benefit.
const bootstrapEnvSchema = z.object({
  BOOTSTRAP_ADMIN_EMAIL: z
    .string({ required_error: 'BOOTSTRAP_ADMIN_EMAIL is required' })
    .trim()
    .toLowerCase()
    .email('BOOTSTRAP_ADMIN_EMAIL must be a valid email address'),
  BOOTSTRAP_ADMIN_NAME: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).max(120).optional(),
  ),
})

export type BootstrapAdminEnv = z.infer<typeof bootstrapEnvSchema>

export function parseBootstrapEnv(env: Record<string, string | undefined>): BootstrapAdminEnv {
  const result = bootstrapEnvSchema.safeParse(env)

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid bootstrap configuration:\n${issues}`)
  }

  return result.data
}

/**
 * Creates the platform owner: the first SUPER_ADMIN, the only role permitted to act on user
 * accounts.
 *
 * Gates on SUPER_ADMIN rather than PLATFORM_ADMIN deliberately. An existing deployment may
 * already have platform admins and still need its first super admin, so counting platform
 * admins here would make the tier unreachable on exactly the installs that need it most.
 */
export async function bootstrapSuperAdmin(
  store: BootstrapAdminStore,
  input: { email: string; displayName?: string },
): Promise<BootstrapAdminResult> {
  const existingAdmins = await store.countSuperAdmins()
  if (existingAdmins > 0) {
    throw new BootstrapAdminRefusedError(
      `Refusing to run: ${existingAdmins} SUPER_ADMIN account(s) already exist. ` +
        'This command bootstraps the first super administrator only — issue further ' +
        'access through an existing super admin.',
    )
  }

  const existing = await store.findUserByEmail(input.email)
  if (existing) {
    throw new BootstrapAdminRefusedError(
      `Refusing to run: ${input.email} already exists with role ${existing.role}. ` +
        'Promoting an existing account to SUPER_ADMIN is a privilege escalation and ' +
        'will not happen as a side effect of this command. Use a fresh address.',
    )
  }

  const password = generatePassword()
  const { id } = await store.createUser({
    email: input.email,
    displayName: input.displayName ?? null,
    passwordHash: await hashPassword(password),
    role: UserRole.SUPER_ADMIN,
    emailVerified: true,
  })

  return { id, email: input.email, password }
}

export function createPrismaStore(prisma: PrismaClient): BootstrapAdminStore {
  return {
    countSuperAdmins: () => prisma.user.count({ where: { role: UserRole.SUPER_ADMIN } }),
    findUserByEmail: (email) =>
      prisma.user.findUnique({ where: { email }, select: { id: true, role: true } }),
    createUser: (input) => prisma.user.create({ data: input, select: { id: true } }),
  }
}

function report(result: BootstrapAdminResult): void {
  // WHY direct stdout instead of the structured logger: the generated password exists
  // only inside this process and has to reach the operator running the command. Routing
  // it through the logger would persist a live super-admin credential into log storage.
  // This is a one-shot operator-run CLI, not an application code path.
  process.stdout.write(
    [
      '',
      'Super administrator created.',
      '',
      `  email:    ${result.email}`,
      `  user id:  ${result.id}`,
      `  password: ${result.password}`,
      '',
      'This password is shown ONCE and is not stored anywhere in recoverable form.',
      'Sign in and change it immediately, then clear it from your shell history.',
      '',
    ].join('\n'),
  )
}

async function main(): Promise<void> {
  const env = parseBootstrapEnv(process.env)
  const prisma = new PrismaClient()

  try {
    report(
      await bootstrapSuperAdmin(createPrismaStore(prisma), {
        email: env.BOOTSTRAP_ADMIN_EMAIL,
        displayName: env.BOOTSTRAP_ADMIN_NAME,
      }),
    )
  } finally {
    await prisma.$disconnect()
  }
}

// Runs only when executed directly, never on import — this must never become
// application-startup behaviour.
if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
