import { createHash } from 'node:crypto';

/**
 * Gera o hash de um payload de negócio em forma canônica: objetos com as mesmas
 * propriedades e valores produzem o mesmo hash mesmo se a ordem das chaves mudar.
 * O chamador deve passar apenas campos de negócio, não metadados de transporte.
 */
export function canonicalPayloadHash(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new Error('INVALID_IDEMPOTENCY_PAYLOAD');
  return createHash('sha256').update(serialized).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
