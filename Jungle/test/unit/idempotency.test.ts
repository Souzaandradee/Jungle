import { describe, expect, test } from 'bun:test';
import { canonicalPayloadHash } from '../../src/domain/idempotency';

describe('business-payload idempotency hash', () => {
  test('does not depend on the order of object keys, including nested keys', () => {
    const first = {
      providerId: 'provider-a',
      money: { amount: '25.00', currency: 'BRL' },
      context: { gameId: 'game-1', roundId: 'round-1' },
    };
    const reordered = {
      context: { roundId: 'round-1', gameId: 'game-1' },
      money: { currency: 'BRL', amount: '25.00' },
      providerId: 'provider-a',
    };

    expect(canonicalPayloadHash(first)).toBe(canonicalPayloadHash(reordered));
  });

  test('changes when a business field changes, so key reuse can be detected as conflict', () => {
    const original = {
      providerId: 'provider-a', externalTransactionId: 'tx-1',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const changed = {
      providerId: 'provider-a', externalTransactionId: 'tx-1',
      money: { amount: '25.01', currency: 'BRL' },
    };

    expect(canonicalPayloadHash(original)).not.toBe(canonicalPayloadHash(changed));
  });
});
