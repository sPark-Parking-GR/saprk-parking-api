import { join } from 'node:path'
import { LifecycleStatus, PrismaClient } from '@prisma/client'
import { FirebaseAuthProvider } from '@spark/auth'
import { z } from 'zod'
import { PrismaAuthJsUserStore } from '../auth/authjs-user.store'
import type { PrismaService } from '../prisma/prisma.service'

/**
 * Repairs what purges that ran before the release path existed left behind.
 *
 * Two kinds of residue, with very different provenance:
 *
 * - OperatorMembership rows still held by PURGED accounts. Derivable from the database
 *   alone, so this half needs no arguments and no judgement — every such row is a live
 *   ADMIN or STAFF grant belonging to an account that has been anonymised, and it goes on
 *   consuming one of the tenant's staff seats.
 *
 * - Identity-provider credentials for addresses the platform has since freed. NOT
 *   derivable: purge nulls firebaseUid and rewrites the email, so once it has run the
 *   database no longer knows which addresses were released or which uid held them. The
 *   addresses have to be named on the command line, recovered from the invite trail or
 *   from whoever is trying to sign up again.
 *
 * Idempotent and safe to re-run: both halves are re-derived from current state, and a
 * credential that is already gone reads as nothing to do rather than as an error.
 *
 * Reports and changes nothing unless --apply is passed. Deleting a credential cannot be
 * undone and locks the person out if the address was chosen wrongly, so the default is to
 * show the operator exactly what would happen.
 */

export class ReconcileRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReconcileRefusedError'
  }
}

export interface StrandedMembership {
  id: string
  userId: string
  operatorId: string
  role: string
}

export interface ReconcileStore {
  findStrandedMemberships(): Promise<StrandedMembership[]>
  deleteMemberships(ids: string[]): Promise<number>
  /** Must see EVERY lifecycle state: an archived or tombstoned account still owns its address. */
  findAnyUserByEmail(email: string): Promise<{ id: string; lifecycleStatus: LifecycleStatus } | null>
}

export interface IdentityStore {
  findIdentityByEmail(email: string): Promise<string | null>
  deleteIdentity(uid: string): Promise<void>
}

export type CredentialOutcome =
  | { email: string; action: 'release'; uid: string }
  | { email: string; action: 'absent' }
  | { email: string; action: 'owned'; userId: string; lifecycleStatus: LifecycleStatus }

export interface ReconcileReport {
  applied: boolean
  memberships: StrandedMembership[]
  credentials: CredentialOutcome[]
}

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('each address must be a valid email address')

export interface ReconcileArgs {
  apply: boolean
  emails: string[]
}

export function parseArgs(argv: string[]): ReconcileArgs {
  const apply = argv.includes('--apply')
  const positional = argv.filter((arg) => !arg.startsWith('--'))

  const emails = positional.map((value) => {
    const parsed = emailSchema.safeParse(value)
    if (!parsed.success) {
      throw new ReconcileRefusedError(`${value}: ${parsed.error.issues[0]?.message}`)
    }
    return parsed.data
  })

  return { apply, emails: [...new Set(emails)] }
}

export async function reconcilePurged(
  store: ReconcileStore,
  identities: IdentityStore,
  args: ReconcileArgs,
): Promise<ReconcileReport> {
  const memberships = await store.findStrandedMemberships()

  const credentials: CredentialOutcome[] = []
  for (const email of args.emails) {
    // Checked before Firebase is asked anything. An address that still belongs to a local
    // account — in ANY lifecycle state, including one merely archived and due to come back —
    // is a live person whose credential must not be destroyed. Refusing per-address rather
    // than aborting the run keeps one bad argument from blocking the rest of the cleanup.
    const owner = await store.findAnyUserByEmail(email)
    if (owner) {
      credentials.push({
        email,
        action: 'owned',
        userId: owner.id,
        lifecycleStatus: owner.lifecycleStatus,
      })
      continue
    }

    const uid = await identities.findIdentityByEmail(email)
    if (!uid) {
      credentials.push({ email, action: 'absent' })
      continue
    }
    credentials.push({ email, action: 'release', uid })
  }

  if (!args.apply) {
    return { applied: false, memberships, credentials }
  }

  if (memberships.length > 0) {
    await store.deleteMemberships(memberships.map((row) => row.id))
  }
  for (const outcome of credentials) {
    if (outcome.action === 'release') await identities.deleteIdentity(outcome.uid)
  }

  return { applied: true, memberships, credentials }
}

export function createPrismaStore(prisma: PrismaClient): ReconcileStore {
  return {
    findStrandedMemberships: async () => {
      const rows = await prisma.operatorMembership.findMany({
        where: { user: { lifecycleStatus: LifecycleStatus.PURGED } },
        select: { id: true, userId: true, operatorId: true, role: true },
        orderBy: { id: 'asc' },
      })
      return rows.map((row) => ({ ...row, role: String(row.role) }))
    },
    deleteMemberships: async (ids) => {
      const { count } = await prisma.operatorMembership.deleteMany({ where: { id: { in: ids } } })
      return count
    },
    findAnyUserByEmail: (email) =>
      prisma.user.findUnique({
        where: { email },
        select: { id: true, lifecycleStatus: true },
      }),
  }
}

// Narrow schema of its own, matching bootstrap-admin's reasoning: this command needs the
// database and the Firebase credentials, and nothing else the API server validates at boot.
const reconcileEnvSchema = z.object({
  FIREBASE_PROJECT_ID: z.string({ required_error: 'FIREBASE_PROJECT_ID is required' }).min(1),
  FIREBASE_CLIENT_EMAIL: z.string({ required_error: 'FIREBASE_CLIENT_EMAIL is required' }).min(1),
  FIREBASE_PRIVATE_KEY: z.string({ required_error: 'FIREBASE_PRIVATE_KEY is required' }).min(1),
  FIREBASE_API_KEY: z.string({ required_error: 'FIREBASE_API_KEY is required' }).min(1),
})

export function createFirebaseIdentityStore(
  env: Record<string, string | undefined>,
  prisma: PrismaClient,
): IdentityStore {
  const parsed = reconcileEnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new ReconcileRefusedError(`Invalid Firebase configuration:\n${issues}`)
  }

  const provider = new FirebaseAuthProvider({
    projectId: parsed.data.FIREBASE_PROJECT_ID,
    clientEmail: parsed.data.FIREBASE_CLIENT_EMAIL,
    privateKey: parsed.data.FIREBASE_PRIVATE_KEY,
    apiKey: parsed.data.FIREBASE_API_KEY,
    store: new PrismaAuthJsUserStore(prisma as unknown as PrismaService),
  })

  return {
    findIdentityByEmail: (email) => provider.findIdentityByEmail(email),
    deleteIdentity: (uid) => provider.deleteIdentity(uid),
  }
}

export function formatReport(report: ReconcileReport): string {
  const verb = report.applied ? 'Released' : 'Would release'
  const lines: string[] = ['']

  lines.push(
    report.memberships.length === 0
      ? 'Operator memberships: none held by purged accounts.'
      : `Operator memberships: ${verb.toLowerCase()} ${report.memberships.length}.`,
  )
  for (const row of report.memberships) {
    lines.push(`  - ${row.role} on operator ${row.operatorId}, held by purged user ${row.userId}`)
  }

  lines.push('')
  if (report.credentials.length === 0) {
    lines.push('Identity credentials: no addresses given.')
  } else {
    lines.push('Identity credentials:')
    for (const outcome of report.credentials) {
      if (outcome.action === 'release') {
        lines.push(`  - ${outcome.email}: ${verb.toLowerCase()} identity ${outcome.uid}`)
      } else if (outcome.action === 'absent') {
        lines.push(`  - ${outcome.email}: nothing registered, already clean`)
      } else {
        lines.push(
          `  - ${outcome.email}: SKIPPED — still owned by account ${outcome.userId} ` +
            `(${outcome.lifecycleStatus}). Purge that account first if you meant to free it.`,
        )
      }
    }
  }

  lines.push('')
  if (!report.applied) {
    lines.push('Dry run. Nothing was changed. Re-run with --apply to perform it.')
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * The API server gets its configuration through Nest; a ts-node script gets nothing. Node's
 * own loader is used rather than a dependency, and it leaves any variable already present
 * alone, so a real deployment that exports its own configuration is unaffected. A missing
 * file is not an error — it just means the environment is expected to supply the values.
 */
function loadLocalEnv(): void {
  try {
    process.loadEnvFile(join(__dirname, '..', '..', '.env'))
  } catch {
    // No local .env; whatever the shell exported is what this run gets.
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  loadLocalEnv()
  const prisma = new PrismaClient()

  try {
    const identities = args.emails.length
      ? createFirebaseIdentityStore(process.env, prisma)
      : // Asked for no addresses, so the credential half has nothing to do and the Firebase
        // configuration is not required to run the membership half.
        { findIdentityByEmail: async () => null, deleteIdentity: async () => undefined }

    const report = await reconcilePurged(createPrismaStore(prisma), identities, args)
    process.stdout.write(formatReport(report))
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
