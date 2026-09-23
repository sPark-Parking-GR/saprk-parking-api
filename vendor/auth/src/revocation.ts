// Server-side session revocation, expressed as a timestamp watermark rather than a
// version counter embedded in the token: this platform has two token issuers and we
// only control the claims of one of them. Every JWT already carries a standard `iat`,
// so comparing it to the watermark works identically for our own tokens and for
// Firebase-issued ID tokens.
//
// `iat` is truncated to whole seconds, so a token minted anywhere inside the revocation
// second is indistinguishable from one minted just before it. Ties therefore go to the
// revocation (fail closed): a session only survives if it is issued in a strictly later
// second than the watermark.
export function isRevokedByWatermark(
  issuedAtSeconds: number,
  sessionsValidFrom: Date | null | undefined,
): boolean {
  if (!sessionsValidFrom) return false
  return issuedAtSeconds <= Math.floor(sessionsValidFrom.getTime() / 1000)
}
