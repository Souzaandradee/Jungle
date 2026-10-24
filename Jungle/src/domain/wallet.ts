import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new Error('NEGATIVE_INITIAL_BALANCE');
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Rebuilds persisted state without rerunning transition rules. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  debit(amount: Money, now = new Date()): void {
    this.assertSameCurrency(amount);
    if (amount.isNegative()) throw new Error('NEGATIVE_DEBIT');
    const next = this._balance.subtract(amount);
    if (next.isNegative()) throw new Error('INSUFFICIENT_FUNDS');
    this.applyBalance(next, now);
  }

  credit(amount: Money, now = new Date()): void {
    this.assertSameCurrency(amount);
    if (amount.isNegative()) throw new Error('NEGATIVE_CREDIT');
    this.applyBalance(this._balance.add(amount), now);
  }

  private applyBalance(next: Money, now: Date): void {
    if (!this._balance.equals(next)) {
      this._balance = next;
      this._version += 1;
      this._updatedAt = now;
    }
  }

  private assertSameCurrency(amount: Money): void {
    if (this.currency !== amount.currency) throw new Error('CURRENCY_MISMATCH');
  }
}
