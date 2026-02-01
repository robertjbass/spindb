/**
 * TLS Certificate Generator
 *
 * Generates self-signed TLS certificates for secure database connections.
 * Uses openssl command-line tool which is available on macOS, Linux, and Windows (Git Bash).
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

const execFileAsync = promisify(execFile)

export type TLSCertificateOptions = {
  // Output directory for certificates
  outputDir: string
  // Common Name (CN) for the certificate (default: localhost)
  commonName?: string
  // Validity period in days (default: 365)
  validDays?: number
  // Organization name (default: SpinDB)
  organization?: string
}

export type TLSCertificateResult = {
  certPath: string
  keyPath: string
}

/**
 * Generate self-signed TLS certificates using openssl
 * @param options Certificate generation options
 * @returns Paths to the generated certificate and key files
 */
export async function generateTLSCertificates(
  options: TLSCertificateOptions,
): Promise<TLSCertificateResult> {
  const {
    outputDir,
    commonName = 'localhost',
    validDays = 365,
    organization = 'SpinDB',
  } = options

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true })

  const certPath = join(outputDir, 'server.crt')
  const keyPath = join(outputDir, 'server.key')

  // Build the subject string for the certificate
  const subject = `/O=${organization}/CN=${commonName}`

  // Generate self-signed certificate with openssl
  // -x509: output a self-signed certificate instead of a CSR
  // -newkey rsa:2048: generate a 2048-bit RSA key
  // -nodes: don't encrypt the private key
  // -keyout: output path for the private key
  // -out: output path for the certificate
  // -days: validity period
  // -subj: subject for the certificate
  // -addext: add Subject Alternative Name for localhost
  try {
    await execFileAsync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      String(validDays),
      '-subj',
      subject,
      '-addext',
      `subjectAltName=DNS:${commonName},DNS:localhost,IP:127.0.0.1`,
    ])
  } catch (error) {
    const e = error as Error
    throw new Error(
      `Failed to generate TLS certificates: ${e.message}. ` +
        'Make sure openssl is installed and available in PATH.',
    )
  }

  return { certPath, keyPath }
}

/**
 * Check if openssl is available on the system
 * @returns true if openssl is available
 */
export async function isOpenSSLAvailable(): Promise<boolean> {
  try {
    await execFileAsync('openssl', ['version'])
    return true
  } catch {
    return false
  }
}

/**
 * Check if TLS certificates already exist in a directory
 * @param certsDir Directory to check
 * @returns true if both server.crt and server.key exist
 */
export function tlsCertificatesExist(certsDir: string): boolean {
  const certPath = join(certsDir, 'server.crt')
  const keyPath = join(certsDir, 'server.key')
  return existsSync(certPath) && existsSync(keyPath)
}
