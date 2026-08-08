/**
 * AES-256-GCM client-side encryption for the vault.
 * Key derivation: PBKDF2(passphrase, salt, 200_000 iterations, SHA-256) → AES-256-GCM key.
 * The derived key never leaves the browser session.
 */

const VERIFIER_PLAINTEXT = 'vault-v1-ok';
const PBKDF2_ITERATIONS  = 200_000;

// ── encoding helpers ──────────────────────────────────────────────────────────

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ── key derivation ────────────────────────────────────────────────────────────

export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── encrypt / decrypt ─────────────────────────────────────────────────────────

export interface Sealed {
  ciphertext: string; // base64
  iv: string;         // base64 12-byte IV
}

export async function encrypt(key: CryptoKey, plaintext: string): Promise<Sealed> {
  const iv       = crypto.getRandomValues(new Uint8Array(12));
  const encoded  = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { ciphertext: toBase64(cipherBuf), iv: toBase64(iv.buffer) };
}

export async function decrypt(key: CryptoKey, sealed: Sealed): Promise<string> {
  const cipherBuf = fromBase64(sealed.ciphertext);
  const iv        = fromBase64(sealed.iv);
  const plainBuf  = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBuf);
  return new TextDecoder().decode(plainBuf);
}

// ── vault setup / unlock ──────────────────────────────────────────────────────

export interface VaultConfig {
  salt:        string; // base64 16-byte salt
  verifier:    string; // base64 AES-GCM ciphertext of VERIFIER_PLAINTEXT
  verifierIv:  string; // base64 IV for verifier
}

/** Create a new vault config from a passphrase. Call once on first setup. */
export async function createVaultConfig(passphrase: string): Promise<{ config: VaultConfig; key: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await deriveKey(passphrase, salt);
  const { ciphertext, iv } = await encrypt(key, VERIFIER_PLAINTEXT);
  return {
    config: { salt: toBase64(salt.buffer), verifier: ciphertext, verifierIv: iv },
    key,
  };
}

/** Attempt to unlock with passphrase. Returns the CryptoKey on success, null if wrong passphrase. */
export async function unlockVault(passphrase: string, config: VaultConfig): Promise<CryptoKey | null> {
  try {
    const salt = fromBase64(config.salt);
    const key  = await deriveKey(passphrase, salt);
    const plaintext = await decrypt(key, { ciphertext: config.verifier, iv: config.verifierIv });
    return plaintext === VERIFIER_PLAINTEXT ? key : null;
  } catch {
    return null; // decryption failure = wrong passphrase
  }
}

// ── password generator ────────────────────────────────────────────────────────

const CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*-_+=';

export function generatePassword(length = 20): string {
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => CHARSET[b % CHARSET.length]).join('');
}
