import { UserRole } from '@prisma/client'
import { verifyPassword } from '@spark/auth'
import {
  BootstrapAdminRefusedError,
  bootstrapSuperAdmin,
  generatePassword,
  parseBootstrapEnv,
  type BootstrapAdminStore,
  type BootstrapAdminUserInput,
} from './bootstrap-admin'

function makeStore(
  overrides: Partial<BootstrapAdminStore> = {},
): BootstrapAdminStore & { created: BootstrapAdminUserInput[] } {
  const created: BootstrapAdminUserInput[] = []
  return {
    created,
    countSuperAdmins: jest.fn().mockResolvedValue(0),
    findUserByEmail: jest.fn().mockResolvedValue(null),
    createUser: jest.fn(async (input: BootstrapAdminUserInput) => {
      created.push(input)
      return { id: 'user_1' }
    }),
    ...overrides,
  }
}

describe('bootstrapSuperAdmin', () => {
  it('creates a verified SUPER_ADMIN when no super admin exists', async () => {
    const store = makeStore()

    const result = await bootstrapSuperAdmin(store, {
      email: 'founder@spark.gr',
      displayName: 'Founder',
    })

    expect(result.email).toBe('founder@spark.gr')
    expect(result.id).toBe('user_1')
    expect(store.created).toHaveLength(1)
    expect(store.created[0]).toMatchObject({
      email: 'founder@spark.gr',
      displayName: 'Founder',
      role: UserRole.SUPER_ADMIN,
      emailVerified: true,
    })
  })

  it('stores a null displayName when none is supplied', async () => {
    const store = makeStore()

    await bootstrapSuperAdmin(store, { email: 'founder@spark.gr' })

    expect(store.created[0]?.displayName).toBeNull()
  })

  // Deliberately runs at the real production scrypt cost — this is the only end-to-end
  // proof that those parameters actually round-trip. Three derivations at N=2^17 take
  // several seconds, well past jest's 5s default, so the timeout is explicit rather than
  // leaving the suite to fail whenever the CPU is contended.
  it('hashes the generated password with the shared @spark/auth hasher', async () => {
    const store = makeStore()

    const result = await bootstrapSuperAdmin(store, { email: 'founder@spark.gr' })
    const stored = store.created[0]?.passwordHash ?? ''

    expect(stored).not.toContain(result.password)
    expect(stored.startsWith('scrypt$')).toBe(true)
    await expect(verifyPassword(result.password, stored)).resolves.toBe(true)
    await expect(verifyPassword('wrong', stored)).resolves.toBe(false)
  }, 30_000)

  it('refuses and creates nothing when a super admin already exists', async () => {
    const store = makeStore({ countSuperAdmins: jest.fn().mockResolvedValue(1) })

    await expect(
      bootstrapSuperAdmin(store, { email: 'second@spark.gr' }),
    ).rejects.toBeInstanceOf(BootstrapAdminRefusedError)
    await expect(bootstrapSuperAdmin(store, { email: 'second@spark.gr' })).rejects.toThrow(
      /already exist/i,
    )
    expect(store.createUser).not.toHaveBeenCalled()
    expect(store.findUserByEmail).not.toHaveBeenCalled()
  })

  it('refuses to promote an existing non-admin account', async () => {
    const store = makeStore({
      findUserByEmail: jest.fn().mockResolvedValue({ id: 'user_9', role: UserRole.OPERATOR_ADMIN }),
    })

    await expect(bootstrapSuperAdmin(store, { email: 'staff@spark.gr' })).rejects.toThrow(
      /privilege escalation/i,
    )
    expect(store.createUser).not.toHaveBeenCalled()
  })

  it('checks for existing super admins before it looks at the target email', async () => {
    const order: string[] = []
    const store = makeStore({
      countSuperAdmins: jest.fn(async () => {
        order.push('count')
        return 0
      }),
      findUserByEmail: jest.fn(async () => {
        order.push('find')
        return null
      }),
    })

    await bootstrapSuperAdmin(store, { email: 'founder@spark.gr' })

    expect(order).toEqual(['count', 'find'])
  })
})

describe('generatePassword', () => {
  it('returns a 32-character base64url string carrying 192 bits of entropy', () => {
    const password = generatePassword()

    expect(password).toHaveLength(32)
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('never repeats across calls', () => {
    const passwords = new Set(Array.from({ length: 200 }, () => generatePassword()))

    expect(passwords.size).toBe(200)
  })
})

describe('parseBootstrapEnv', () => {
  it('normalises the email to trimmed lowercase', () => {
    const env = parseBootstrapEnv({ BOOTSTRAP_ADMIN_EMAIL: '  Founder@Spark.GR ' })

    expect(env.BOOTSTRAP_ADMIN_EMAIL).toBe('founder@spark.gr')
    expect(env.BOOTSTRAP_ADMIN_NAME).toBeUndefined()
  })

  it('rejects a missing or malformed email', () => {
    expect(() => parseBootstrapEnv({})).toThrow(/BOOTSTRAP_ADMIN_EMAIL/)
    expect(() => parseBootstrapEnv({ BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' })).toThrow(
      /valid email address/,
    )
  })

  it('treats a blank display name as absent', () => {
    const env = parseBootstrapEnv({
      BOOTSTRAP_ADMIN_EMAIL: 'founder@spark.gr',
      BOOTSTRAP_ADMIN_NAME: '   ',
    })

    expect(env.BOOTSTRAP_ADMIN_NAME).toBeUndefined()
  })

  it('ignores unrelated env vars, including any attempt to supply a password', () => {
    const env = parseBootstrapEnv({
      BOOTSTRAP_ADMIN_EMAIL: 'founder@spark.gr',
      BOOTSTRAP_ADMIN_NAME: 'Founder',
      BOOTSTRAP_ADMIN_PASSWORD: 'hunter2',
    })

    expect(env.BOOTSTRAP_ADMIN_NAME).toBe('Founder')
    expect(Object.keys(env)).toEqual(['BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_NAME'])
  })
})
