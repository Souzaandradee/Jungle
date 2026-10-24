import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';

describe('Money', () => {
  test('uses decimal strings and preserves cents exactly', () => {
    const total = Money.from({ amount: '0.10', currency: 'BRL' })
      .add(Money.from({ amount: '0.20', currency: 'BRL' }));
    expect(total.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  });

  test('requires two decimal places on input and serializes fixed scale', () => {
    expect(Money.from({ amount: '25.00', currency: 'BRL' }).toJSON().amount).toBe('25.00');
    expect(Money.from({ amount: '25.20', currency: 'BRL' }).toString()).toBe('25.20 BRL');
    expect(() => Money.from({ amount: '25', currency: 'BRL' })).toThrow('INVALID_MONEY_AMOUNT');
    expect(() => Money.from({ amount: '25.2', currency: 'BRL' })).toThrow('INVALID_MONEY_AMOUNT');
  });

  test.each(['', '-1.00', '+1.00', '1', '1.0', '1.001', 'NaN', 'Infinity', '1e3', ' 1.00', '1.00 '])(
    'rejects invalid amount input %s',
    (amount: string) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow();
    },
  );

  test.each(['ZZZ', 'brl', 'US', '123', '', 'ANG', 'BGN', 'XTS', 'XXX'])('rejects a non-current ISO 4217 code: %s', (currency: string) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow('INVALID_CURRENCY');
    expect(() => Money.zero(currency)).toThrow('INVALID_CURRENCY');
  });

  test('supports current currency, fund, metal, and ISO fund-assignment codes', () => {
    expect(Money.from({ amount: '10.00', currency: 'BRL' }).currency).toBe('BRL');
    expect(Money.from({ amount: '10.00', currency: 'USD' }).currency).toBe('USD');
    // XAD is the current ISO 4217 Arab Accounting Dinar fund code (effective 2025-05-12).
    expect(Money.from({ amount: '10.00', currency: 'XAD' }).currency).toBe('XAD');
    const metal = Money.from({ amount: '10.00', currency: 'XAU' });
    expect(metal.currency).toBe('XAU');
  });

  test('rejects cross-currency math', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow('CURRENCY_MISMATCH');
    expect(() => brl.equals(usd)).toThrow('CURRENCY_MISMATCH');
  });

  test('domain subtraction may produce a signed difference for reconciliation', () => {
    const difference = Money.from({ amount: '5.00', currency: 'BRL' })
      .subtract(Money.from({ amount: '7.00', currency: 'BRL' }));
    expect(difference.toJSON()).toEqual({ amount: '-2.00', currency: 'BRL' });
    expect(difference.isNegative()).toBe(true);
  });

  test('accepts the largest numeric(20,2) amount and rejects arithmetic overflow', () => {
    const max = Money.from({ amount: '999999999999999999.99', currency: 'BRL' });
    expect(max.toJSON().amount).toBe('999999999999999999.99');
    expect(() => max.add(Money.from({ amount: '0.01', currency: 'BRL' }))).toThrow('MONEY_AMOUNT_OUT_OF_RANGE');
    expect(() => Money.from({ amount: '1000000000000000000.00', currency: 'BRL' })).toThrow('INVALID_MONEY_AMOUNT');
  });

  test('keeps decimal precision for large amounts without converting to number', () => {
    const value = Money.from({ amount: '123456789012345.67', currency: 'BRL' })
      .add(Money.from({ amount: '0.33', currency: 'BRL' }));
    expect(value.toJSON().amount).toBe('123456789012346.00');
  });
});
