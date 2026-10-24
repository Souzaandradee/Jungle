import Decimal from 'decimal.js';
import { isIso4217Currency } from './currency';

export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Exact, immutable money. Public input is unsigned and must have exactly two decimals. */
export class Money {
  private static readonly MAX_VALUE = new Decimal('999999999999999999.99');

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string') {
      throw new Error('MONEY_AMOUNT_MUST_BE_DECIMAL_STRING');
    }
    // Valida a string antes de convertê-la: usar number aqui pode introduzir arredondamento binário.
    // O formato também limita a escala e os dígitos inteiros aceitos pelo numeric(20,2) do banco.
    if (!/^\d{1,18}\.\d{2}$/.test(props.amount)) {
      throw new Error('INVALID_MONEY_AMOUNT');
    }
    if (!isIso4217Currency(props.currency)) {
      throw new Error('INVALID_CURRENCY');
    }

    const amount = new Decimal(props.amount);
    if (!amount.isFinite()) throw new Error('INVALID_MONEY_AMOUNT');
    if (amount.isNegative()) throw new Error('NEGATIVE_MONEY_INPUT');
    if (amount.greaterThan(Money.MAX_VALUE)) throw new Error('MONEY_AMOUNT_OUT_OF_RANGE');
    return new Money(amount, props.currency);
  }

  static zero(currency: string): Money {
    if (!isIso4217Currency(currency)) throw new Error('INVALID_CURRENCY');
    return new Money(new Decimal(0), currency);
  }

  /** Internal factory for arithmetic that can legitimately produce a signed result. */
  private static arithmetic(value: Decimal, currency: string): Money {
    if (!value.isFinite() || value.abs().greaterThan(Money.MAX_VALUE)) {
      throw new Error('MONEY_AMOUNT_OUT_OF_RANGE');
    }
    // All inputs have scale 2, so arithmetic is exact and never needs rounding.
    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.arithmetic(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.arithmetic(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.arithmetic(this.value.negated(), this.currency);
  }

  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.greaterThan(0); }
  isNegative(): boolean { return this.value.isNegative(); }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string { return `${this.value.toFixed(2)} ${this.currency}`; }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new Error('CURRENCY_MISMATCH');
  }
}
