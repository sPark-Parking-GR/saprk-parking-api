import { randomBytes, scryptSync } from 'node:crypto'
import { CURRENT_SCRYPT_PARAMS, hashPassword, verifyPassword, type ScryptParams } from '../crypto'
import { InvalidCredentialsError } from '../errors'
import {
  AuthJsProvider,
  type AuthJsConfig,
  type AuthJsCreateUserInput,
  type AuthJsUserRecord,
  type AuthJsUserStore,
} from './AuthJsProvider'

const SECRET = 'test-secret-at-least-32-chars-long'
const PASSWORD = 'pw-123456'

// Injected everywhere so the suite never pays the production cost; the rehash logic is
// parameter-driven, so a cheap target exercises exactly the same code path.
const TEST_PARAMS: ScryptParams = { N: 16, r: 8, p: 1 }
const WEAKER_PARAMS: ScryptParams = { N: 2, r: 8, p: 1 }

function legacyHash(plain: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(plain, salt, 64)
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

class InMemoryStore implements AuthJsUserStore {
  readonly updates: Array<{ id: string; passwordHash: string }> = []
  private readonly byId = new Map<string, AuthJsUserRecord>()
  private seq = 0

  // Copies, like a real repository: the provider must persist through updatePassword, not
  // by mutating a row object it happens to share with the store.
  private clone(record: AuthJsUserRecord): AuthJsUserRecord {
    return { ...record }
  }

  seed(email: string, passwordHash: string): AuthJsUserRecord {
    const record: AuthJsUserRecord = {
      id: `u${++this.seq}`,
      email,
      role: 'user',
      emailVerified: false,
      displayName: null,
      avatarUrl: null,
      passwordHash,
    }
    this.byId.set(record.id, record)
    return this.clone(record)
  }

  async findByEmail(email: string): Promise<AuthJsUserRecord | null> {
    const found = [...this.byId.values()].find((u) => u.email === email)
    return found ? this.clone(found) : null
  }

  async findById(id: string): Promise<AuthJsUserRecord | null> {
    const found = this.byId.get(id)
    return found ? this.clone(found) : null
  }

  async createUser(input: AuthJsCreateUserInput): Promise<AuthJsUserRecord> {
    return this.seed(input.email, input.passwordHash)
  }

  async deleteUser(id: string): Promise<void> {
    this.byId.delete(id)
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    this.updates.push({ id, passwordHash })
    const record = this.byId.get(id)
    if (record) record.passwordHash = passwordHash
  }

  async upgradePassword(id: string, expectedHash: string, passwordHash: string): Promise<void> {
    const record = this.byId.get(id)
    if (!record || record.passwordHash !== expectedHash) return
    this.updates.push({ id, passwordHash })
    record.passwordHash = passwordHash
  }

  async revokeSessions(id: string, at: Date): Promise<void> {
    const record = this.byId.get(id)
    if (record) record.sessionsValidFrom = at
  }
}

function makeProvider(overrides: Partial<AuthJsConfig> = {}) {
  const store = overrides.store ?? new InMemoryStore()
  const provider = new AuthJsProvider({
    secret: SECRET,
    passwordParams: TEST_PARAMS,
    ...overrides,
    store,
  })
  return { store: store as InMemoryStore, provider }
}

describe('AuthJsProvider password hashing', () => {
  it('hashes sign-up passwords at the configured parameters', async () => {
    const { store, provider } = makeProvider()

    await provider.signUp({ email: 'a@spark.gr', password: PASSWORD })
    const stored = (await store.findById('u1'))?.passwordHash ?? ''

    expect(stored.split('$')[1]).toBe('N=16,r=8,p=1')
    expect(stored).not.toContain(PASSWORD)
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true)
  })

  it('rewrites the credential at the configured parameters on reset', async () => {
    const { store, provider } = makeProvider()
    store.seed('a@spark.gr', legacyHash(PASSWORD))

    await provider.resetPassword({ email: 'a@spark.gr' }, 'fresh-pw-99')
    const stored = (await store.findById('u1'))?.passwordHash ?? ''

    expect(stored.split('$')).toHaveLength(4)
    await expect(verifyPassword('fresh-pw-99', stored)).resolves.toBe(true)
  })

  it('defaults to the production parameters when none are injected', () => {
    const provider = new AuthJsProvider({ secret: SECRET, store: new InMemoryStore() })

    expect(provider.providerName).toBe('authjs')
    expect(CURRENT_SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1 })
  })
})

describe('AuthJsProvider rehash on sign-in', () => {
  it('upgrades a legacy hash to the versioned format and persists it', async () => {
    const { store, provider } = makeProvider()
    const seeded = store.seed('a@spark.gr', legacyHash(PASSWORD))
    expect(seeded.passwordHash.split('$')).toHaveLength(3)

    const result = await provider.signIn({ email: 'a@spark.gr', password: PASSWORD })

    expect(result.session.user.email).toBe('a@spark.gr')
    expect(store.updates).toEqual([{ id: 'u1', passwordHash: expect.any(String) }])
    const stored = (await store.findById('u1'))?.passwordHash ?? ''
    expect(stored.split('$')).toHaveLength(4)
    expect(stored.split('$')[1]).toBe('N=16,r=8,p=1')
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true)
  })

  it('upgrades a versioned hash that sits below the current cost', async () => {
    const { store, provider } = makeProvider()
    store.seed('a@spark.gr', await hashPassword(PASSWORD, WEAKER_PARAMS))

    await provider.signIn({ email: 'a@spark.gr', password: PASSWORD })

    expect((await store.findById('u1'))?.passwordHash.split('$')[1]).toBe('N=16,r=8,p=1')
  })

  it('leaves an already-current hash untouched', async () => {
    const { store, provider } = makeProvider()
    const current = await hashPassword(PASSWORD, TEST_PARAMS)
    store.seed('a@spark.gr', current)

    await provider.signIn({ email: 'a@spark.gr', password: PASSWORD })

    expect(store.updates).toHaveLength(0)
    expect((await store.findById('u1'))?.passwordHash).toBe(current)
  })

  it('never rehashes on a failed sign-in', async () => {
    const { store, provider } = makeProvider()
    store.seed('a@spark.gr', legacyHash(PASSWORD))

    await expect(
      provider.signIn({ email: 'a@spark.gr', password: 'wrong-pass' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)

    expect(store.updates).toHaveLength(0)
    expect((await store.findById('u1'))?.passwordHash.split('$')).toHaveLength(3)
  })

  it('does not resurrect the old credential when a reset lands mid-rehash', async () => {
    const { store, provider } = makeProvider()
    store.seed('a@spark.gr', legacyHash(PASSWORD))
    const reset = await hashPassword('reset-password', TEST_PARAMS)

    // Hashing is slow by design, so a reset can commit between verification and the
    // opportunistic write. The upgrade must lose that race, not silently undo it.
    jest.spyOn(store, 'findByEmail').mockImplementation(async () => {
      const record = { ...(await new InMemoryStore().seed('a@spark.gr', legacyHash(PASSWORD))) }
      await store.updatePassword('u1', reset)
      return record
    })

    await provider.signIn({ email: 'a@spark.gr', password: PASSWORD })

    expect((await store.findById('u1'))?.passwordHash).toBe(reset)
  })

  it('still signs the user in when persisting the upgraded hash fails', async () => {
    const store = new InMemoryStore()
    const failure = new Error('database unavailable')
    jest.spyOn(store, 'upgradePassword').mockRejectedValue(failure)
    const onPasswordUpgradeError = jest.fn()
    const { provider } = makeProvider({ store, onPasswordUpgradeError })
    store.seed('a@spark.gr', legacyHash(PASSWORD))

    const result = await provider.signIn({ email: 'a@spark.gr', password: PASSWORD })

    expect(result.session.accessToken).toEqual(expect.any(String))
    expect(await provider.verifyToken(result.session.accessToken)).not.toBeNull()
    expect(onPasswordUpgradeError).toHaveBeenCalledWith(failure, 'u1')
  })

  it('survives a store failure even with no error hook configured', async () => {
    const store = new InMemoryStore()
    jest.spyOn(store, 'upgradePassword').mockRejectedValue(new Error('database unavailable'))
    const { provider } = makeProvider({ store })
    store.seed('a@spark.gr', legacyHash(PASSWORD))

    await expect(
      provider.signIn({ email: 'a@spark.gr', password: PASSWORD }),
    ).resolves.toMatchObject({ session: { user: { email: 'a@spark.gr' } } })
  })
})
