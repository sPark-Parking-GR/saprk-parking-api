import {
  AuthJsProvider,
  EmailInUseError,
  InvalidCredentialsError,
  InvalidTokenError,
  type AuthJsCreateUserInput,
  type AuthJsUserRecord,
  type AuthJsUserStore,
} from '@spark/auth'

const SECRET = 'test-secret-at-least-16-chars-long'

class InMemoryStore implements AuthJsUserStore {
  private readonly byId = new Map<string, AuthJsUserRecord>()
  private seq = 0

  async findByEmail(email: string): Promise<AuthJsUserRecord | null> {
    return [...this.byId.values()].find((u) => u.email === email) ?? null
  }
  async findById(id: string): Promise<AuthJsUserRecord | null> {
    return this.byId.get(id) ?? null
  }
  async createUser(input: AuthJsCreateUserInput): Promise<AuthJsUserRecord> {
    const record: AuthJsUserRecord = {
      id: `u${++this.seq}`,
      email: input.email,
      role: input.role,
      emailVerified: false,
      displayName: input.displayName ?? null,
      avatarUrl: null,
      passwordHash: input.passwordHash,
    }
    this.byId.set(record.id, record)
    return record
  }
  async deleteUser(id: string): Promise<void> {
    this.byId.delete(id)
  }
}

function makeProvider(overrides: { accessTtlSeconds?: number } = {}) {
  const store = new InMemoryStore()
  const provider = new AuthJsProvider({ secret: SECRET, store, ...overrides })
  return { store, provider }
}

describe('AuthJsProvider', () => {
  it('rejects a too-short secret', () => {
    expect(() => new AuthJsProvider({ secret: 'short', store: new InMemoryStore() })).toThrow()
  })

  it('signs up then signs in and verifies the access token', async () => {
    const { provider } = makeProvider()
    const signUp = await provider.signUp({ email: 'A@Spark.gr', password: 'pw-123456', role: 'operator_admin' })
    expect(signUp.session.user.email).toBe('a@spark.gr')
    expect(signUp.session.user.role).toBe('operator_admin')

    const signIn = await provider.signIn({ email: 'a@spark.gr', password: 'pw-123456' })
    const verified = await provider.verifyToken(signIn.session.accessToken)
    expect(verified).not.toBeNull()
    expect(verified?.isExpired).toBe(false)
    expect(verified?.user.role).toBe('operator_admin')
  })

  it('rejects a wrong password', async () => {
    const { provider } = makeProvider()
    await provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })
    await expect(provider.signIn({ email: 'a@spark.gr', password: 'wrong-pass' })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    )
  })

  it('rejects duplicate sign-up', async () => {
    const { provider } = makeProvider()
    await provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })
    await expect(provider.signUp({ email: 'A@spark.gr', password: 'pw-123456' })).rejects.toBeInstanceOf(
      EmailInUseError,
    )
  })

  it('returns null for a tampered token', async () => {
    const { provider } = makeProvider()
    const { session } = await provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })
    expect(await provider.verifyToken(session.accessToken + 'x')).toBeNull()
    expect(await provider.verifyToken('not.a.jwt')).toBeNull()
  })

  it('marks an expired access token as expired but still parses the user', async () => {
    const { provider } = makeProvider({ accessTtlSeconds: -1 })
    const { session } = await provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })
    const verified = await provider.verifyToken(session.accessToken)
    expect(verified?.isExpired).toBe(true)
  })

  it('refreshes into a new session and rejects an access token used as refresh', async () => {
    const { provider } = makeProvider()
    const { session } = await provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })

    const refreshed = await provider.refreshToken(session.refreshToken)
    expect(refreshed.session.user.email).toBe('a@spark.gr')
    expect((await provider.verifyToken(refreshed.session.accessToken))?.isExpired).toBe(false)

    await expect(provider.refreshToken(session.accessToken)).rejects.toBeInstanceOf(InvalidTokenError)
  })
})
