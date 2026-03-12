/**
 * libSQL JWT Authentication unit tests
 *
 * Tests Ed25519 key generation, JWT creation, format validation,
 * and signature verification following the same pattern used by
 * the libSQL engine's createJwt() function.
 */

import { describe, it } from 'node:test'
import { generateKeyPairSync, sign, verify, createPublicKey } from 'crypto'
import { assert, assertEqual, assertTruthy } from '../utils/assertions'

/**
 * Re-implement createJwt locally so we can test the JWT format and
 * signature logic without needing to export the private function
 * from the engine module.
 */
function createJwt(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }),
  ).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ a: 'rw' })).toString('base64url')
  const signingInput = `${header}.${payload}`
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString(
    'base64url',
  )
  return `${signingInput}.${signature}`
}

describe('libSQL JWT Authentication', () => {
  describe('JWT token format', () => {
    it('should produce a three-part dot-separated token', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const parts = token.split('.')
      assertEqual(
        parts.length,
        3,
        'JWT should have 3 parts (header.payload.signature)',
      )
    })

    it('should have base64url-encoded header', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const headerPart = token.split('.')[0]
      // base64url should not contain +, /, or = (padding)
      assert(
        !/[+/=]/.test(headerPart),
        'Header should be base64url (no +, /, or =)',
      )

      // Should decode to valid JSON
      const decoded = Buffer.from(headerPart, 'base64url').toString('utf-8')
      const parsed = JSON.parse(decoded)
      assert(typeof parsed === 'object', 'Header should decode to an object')
    })

    it('should have base64url-encoded payload', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const payloadPart = token.split('.')[1]
      assert(
        !/[+/=]/.test(payloadPart),
        'Payload should be base64url (no +, /, or =)',
      )

      const decoded = Buffer.from(payloadPart, 'base64url').toString('utf-8')
      const parsed = JSON.parse(decoded)
      assert(typeof parsed === 'object', 'Payload should decode to an object')
    })

    it('should have base64url-encoded signature', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const signaturePart = token.split('.')[2]
      assert(signaturePart.length > 0, 'Signature part should not be empty')
      assert(
        !/[+/=]/.test(signaturePart),
        'Signature should be base64url (no +, /, or =)',
      )
    })
  })

  describe('JWT header', () => {
    it('should have alg set to EdDSA', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const headerPart = token.split('.')[0]
      const header = JSON.parse(
        Buffer.from(headerPart, 'base64url').toString('utf-8'),
      )

      assertEqual(header.alg, 'EdDSA', 'Algorithm should be EdDSA')
    })

    it('should have typ set to JWT', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const headerPart = token.split('.')[0]
      const header = JSON.parse(
        Buffer.from(headerPart, 'base64url').toString('utf-8'),
      )

      assertEqual(header.typ, 'JWT', 'Type should be JWT')
    })

    it('should have exactly alg and typ fields', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const headerPart = token.split('.')[0]
      const header = JSON.parse(
        Buffer.from(headerPart, 'base64url').toString('utf-8'),
      )

      const keys = Object.keys(header).sort()
      assertEqual(keys.length, 2, 'Header should have exactly 2 keys')
      assertEqual(keys[0], 'alg', 'First key should be alg')
      assertEqual(keys[1], 'typ', 'Second key should be typ')
    })
  })

  describe('JWT payload', () => {
    it('should have "a" claim set to "rw"', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const payloadPart = token.split('.')[1]
      const payload = JSON.parse(
        Buffer.from(payloadPart, 'base64url').toString('utf-8'),
      )

      assertEqual(payload.a, 'rw', 'Payload "a" claim should be "rw"')
    })

    it('should have exactly one claim', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const payloadPart = token.split('.')[1]
      const payload = JSON.parse(
        Buffer.from(payloadPart, 'base64url').toString('utf-8'),
      )

      const keys = Object.keys(payload)
      assertEqual(keys.length, 1, 'Payload should have exactly 1 key')
      assertEqual(keys[0], 'a', 'Only key should be "a"')
    })
  })

  describe('Ed25519 key generation and JWT signing', () => {
    it('should generate a valid Ed25519 key pair', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')

      assertTruthy(publicKey, 'Public key should be generated')
      assertTruthy(privateKey, 'Private key should be generated')

      assertEqual(
        publicKey.asymmetricKeyType,
        'ed25519',
        'Public key should be Ed25519',
      )
      assertEqual(
        privateKey.asymmetricKeyType,
        'ed25519',
        'Private key should be Ed25519',
      )
    })

    it('should produce a verifiable signature', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      const parts = token.split('.')
      const signingInput = `${parts[0]}.${parts[1]}`
      const signature = Buffer.from(parts[2], 'base64url')

      const isValid = verify(
        null,
        Buffer.from(signingInput),
        publicKey,
        signature,
      )
      assert(isValid, 'Signature should be verifiable with the public key')
    })

    it('should fail verification with a different key pair', () => {
      const { privateKey } = generateKeyPairSync('ed25519')
      const { publicKey: otherPublicKey } = generateKeyPairSync('ed25519')

      const token = createJwt(privateKey)
      const parts = token.split('.')
      const signingInput = `${parts[0]}.${parts[1]}`
      const signature = Buffer.from(parts[2], 'base64url')

      const isValid = verify(
        null,
        Buffer.from(signingInput),
        otherPublicKey,
        signature,
      )
      assert(
        !isValid,
        'Signature should not verify with a different public key',
      )
    })

    it('should produce different tokens for different key pairs', () => {
      const keyPair1 = generateKeyPairSync('ed25519')
      const keyPair2 = generateKeyPairSync('ed25519')

      const token1 = createJwt(keyPair1.privateKey)
      const token2 = createJwt(keyPair2.privateKey)

      // Header and payload are deterministic, but signatures differ
      const sig1 = token1.split('.')[2]
      const sig2 = token2.split('.')[2]
      assert(
        sig1 !== sig2,
        'Different key pairs should produce different signatures',
      )
    })

    it('should produce the same token for the same key pair', () => {
      const { privateKey } = generateKeyPairSync('ed25519')

      const token1 = createJwt(privateKey)
      const token2 = createJwt(privateKey)

      // Ed25519 signatures are deterministic (no random nonce)
      assertEqual(
        token1,
        token2,
        'Same key pair should produce identical tokens',
      )
    })
  })

  describe('JWT public key export for sqld', () => {
    it('should export public key in PEM format', () => {
      const { publicKey } = generateKeyPairSync('ed25519')

      const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string

      assertTruthy(pem, 'PEM should not be empty')
      assert(
        pem.startsWith('-----BEGIN PUBLIC KEY-----'),
        'PEM should start with BEGIN PUBLIC KEY header',
      )
      assert(
        pem.trimEnd().endsWith('-----END PUBLIC KEY-----'),
        'PEM should end with END PUBLIC KEY footer',
      )
    })

    it('should produce a PEM that can be re-imported and used for verification', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const token = createJwt(privateKey)

      // Export and re-import the public key (simulates sqld reading the file)
      const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
      const reimported = createPublicKey({ key: pem, format: 'pem' })

      const parts = token.split('.')
      const signingInput = `${parts[0]}.${parts[1]}`
      const signature = Buffer.from(parts[2], 'base64url')

      const isValid = verify(
        null,
        Buffer.from(signingInput),
        reimported,
        signature,
      )
      assert(isValid, 'Re-imported PEM key should verify the JWT signature')
    })
  })
})
