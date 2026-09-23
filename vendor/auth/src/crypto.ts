import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { BinaryLike, ScryptOptions } from 'node:crypto'
import { promisify } from 'node:util'

// The callback form, not scryptSync: this runs on libuv's threadpool, so a several-hundred
// millisecond derivation no longer stalls the Fastify event loop for every other request.
// Explicit type arguments pin the 5-parameter overload, which promisify cannot infer.
const scryptAsync = promisify<BinaryLike, BinaryLike, number, ScryptOptions, Buffer>(scrypt)

const SCRYPT_KEYLEN = 64
const SCRYPT_SALT_BYTES = 16
const SCHEME = 'scrypt'

export interface ScryptParams {
  N: number
  r: number
  p: number
}

// OWASP's current scrypt floor. Costs ~128 MiB and a few hundred milliseconds per hash,
// which is precisely why every derivation below runs off the event loop.
export const CURRENT_SCRYPT_PARAMS: ScryptParams = { N: 131072, r: 8, p: 1 }

// What the absence of a parameter segment means: everything hashed before the format
// carried its own cost was hashed with Node's scryptSync defaults.
const LEGACY_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 }

const PARAMS_PATTERN = /^N=(\d+),r=(\d+),p=(\d+)$/
const MAX_MEMORY_BYTES = 256 * 1024 * 1024
const MAX_PARALLELISM = 16

// scrypt allocates 128*r*(N+p+2) bytes and refuses to run past `maxmem`, whose 32 MiB
// default is far below what N=2^17 needs. Deriving the ceiling from the parameters is
// what lets the cost be retuned later without also editing a magic number.
function maxmemFor({ N, r, p }: ScryptParams): number {
  return 128 * r * (N + p + 2)
}

function derive(
  plain: string,
  salt: Buffer,
  keylen: number,
  params: ScryptParams,
): Promise<Buffer> {
  return scryptAsync(plain, salt, keylen, { ...params, maxmem: maxmemFor(params) })
}

// A stored hash is untrusted the moment the row it lives in is: bound the work it can ask
// for so a poisoned column cannot exhaust memory or pin a threadpool thread indefinitely.
function isUsable(params: ScryptParams): boolean {
  const { N, r, p } = params
  return (
    Number.isInteger(N) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    N > 1 &&
    (N & (N - 1)) === 0 &&
    r >= 1 &&
    p >= 1 &&
    p <= MAX_PARALLELISM &&
    maxmemFor(params) <= MAX_MEMORY_BYTES
  )
}

function encodeParams({ N, r, p }: ScryptParams): string {
  return `N=${N},r=${r},p=${p}`
}

function parseParams(segment: string): ScryptParams | null {
  const match = PARAMS_PATTERN.exec(segment)
  if (!match) return null
  const params = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) }
  return isUsable(params) ? params : null
}

interface DecodedHash {
  params: ScryptParams
  versioned: boolean
  salt: Buffer
  expected: Buffer
}

// Two layouts share the `scrypt$` prefix: the legacy `scrypt$salt$hash` and the versioned
// `scrypt$N=…,r=…,p=…$salt$hash`. base64url never emits `$`, `=` or `,`, so the segment
// count alone separates them with no ambiguity.
function decode(stored: string): DecodedHash | null {
  const [scheme, ...rest] = stored.split('$')
  if (scheme !== SCHEME) return null

  if (rest.length !== 2 && rest.length !== 3) return null

  const versioned = rest.length === 3
  const params = versioned ? parseParams(rest[0] ?? '') : LEGACY_SCRYPT_PARAMS
  if (!params) return null

  const saltB64 = versioned ? rest[1] : rest[0]
  const hashB64 = versioned ? rest[2] : rest[1]
  if (!saltB64 || !hashB64) return null

  const salt = Buffer.from(saltB64, 'base64url')
  const expected = Buffer.from(hashB64, 'base64url')
  if (salt.length === 0 || expected.length === 0) return null

  return { params, versioned, salt, expected }
}

// Password hashing uses Node's built-in scrypt so the auth package keeps zero external
// runtime dependencies. `params` is injectable so tests can hash at a trivial cost.
export async function hashPassword(
  plain: string,
  params: ScryptParams = CURRENT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const derived = await derive(plain, salt, SCRYPT_KEYLEN, params)
  return [
    SCHEME,
    encodeParams(params),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const decoded = decode(stored)
  if (!decoded) return false
  const { params, salt, expected } = decoded
  try {
    const derived = await derive(plain, salt, expected.length, params)
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    // A stored value this function cannot process is a failed verification, never a throw
    // that would surface as a 500 on an otherwise ordinary wrong-password attempt.
    return false
  }
}

// A legacy hash is always migrated, whatever its cost: it is stuck in a format that cannot
// record parameters, so leaving it in place would permanently exempt that account from any
// future retuning. Beyond that, work factors are compared rather than exact equality so an
// account hashed above the current cost is never silently downgraded.
export function needsRehash(stored: string, params: ScryptParams = CURRENT_SCRYPT_PARAMS): boolean {
  const decoded = decode(stored)
  if (!decoded) return false
  return !decoded.versioned || workFactor(decoded.params) < workFactor(params)
}

function workFactor({ N, r, p }: ScryptParams): number {
  return N * r * p
}

function encodeSegment(data: object): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url')
}

function hmac(input: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(input).digest()
}

// Minimal stateless HS256 JWT. Avoids an external jsonwebtoken dependency so the
// package stays pure; expiry is carried in the payload and checked by the caller.
export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = encodeSegment({ alg: 'HS256', typ: 'JWT' })
  const body = encodeSegment(payload)
  const signature = hmac(`${header}.${body}`, secret).toString('base64url')
  return `${header}.${body}.${signature}`
}

export function verifyJwt<T = Record<string, unknown>>(token: string, secret: string): T | null {
  const [header, body, signature] = token.split('.')
  if (!header || !body || !signature) return null
  const expected = hmac(`${header}.${body}`, secret)
  const provided = Buffer.from(signature, 'base64url')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}
