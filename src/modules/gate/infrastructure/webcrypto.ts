// WebCrypto-backed adapters — the runtime-portable implementations of the
// crypto ports (globalThis.crypto exists in both Node >=20 and Cloudflare
// Workers, per ADR-0006). Verification only: signing belongs to the vendor's
// backend (ADR-0005 §7) and to test helpers.
import type { TokenClaims } from '../domain/types.ts';
import type { Clock, Hasher, TokenVerifier } from '../application/ports.ts';

/**
 * Public JWK (EC P-256) as stored in the control plane's `vendor_keys`.
 * Structural type so this file stays free of platform type-lib dependencies.
 */
export interface PublicJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y: string;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

export class WebCryptoHasher implements Hasher {
  async sha256hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface WireClaims {
  readonly sub?: unknown;
  readonly tenant_id?: unknown;
  readonly sid?: unknown;
  readonly epoch?: unknown;
  readonly exp?: unknown;
  readonly aud?: unknown;
}

/**
 * ES256 JWT verifier keyed by `kid` — one public JWK per vendor signing key
 * (control-plane `vendor_keys`; public keys only, GR-001).
 */
export class Es256TokenVerifier implements TokenVerifier {
  readonly #keys: ReadonlyMap<string, PublicJwk>;
  readonly #aud: string;
  readonly #imported = new Map<string, CryptoKey>();

  constructor(keysByKid: ReadonlyMap<string, PublicJwk>, aud: string) {
    this.#keys = keysByKid;
    this.#aud = aud;
  }

  async #key(kid: string): Promise<CryptoKey | null> {
    const cached = this.#imported.get(kid);
    if (cached) return cached;
    const jwk = this.#keys.get(kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    this.#imported.set(kid, key);
    return key;
  }

  async verify(
    token: string,
    nowMs: number,
  ): Promise<{ ok: true; claims: TokenClaims } | { ok: false; reason: string }> {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [h, p, s] = parts as [string, string, string];
    let kid: string;
    let wire: WireClaims;
    try {
      const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as {
        alg?: unknown;
        kid?: unknown;
      };
      if (header.alg !== 'ES256' || typeof header.kid !== 'string')
        return { ok: false, reason: 'bad-header' };
      kid = header.kid;
      wire = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as WireClaims;
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    const key = await this.#key(kid);
    if (!key) return { ok: false, reason: 'unknown-kid' };
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!valid) return { ok: false, reason: 'bad-signature' };
    if (
      typeof wire.sub !== 'string' ||
      typeof wire.tenant_id !== 'string' ||
      typeof wire.sid !== 'string' ||
      typeof wire.epoch !== 'number' ||
      typeof wire.exp !== 'number' ||
      typeof wire.aud !== 'string'
    )
      return { ok: false, reason: 'bad-claims' };
    if (wire.exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };
    if (wire.aud !== this.#aud) return { ok: false, reason: 'bad-aud' };
    return {
      ok: true,
      claims: {
        sub: wire.sub,
        tenantId: wire.tenant_id,
        sessionId: wire.sid,
        epoch: wire.epoch,
        exp: wire.exp,
        aud: wire.aud,
      },
    };
  }
}
