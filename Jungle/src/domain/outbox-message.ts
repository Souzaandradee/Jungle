import { IntegrationEventEnvelope } from './events';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEventEnvelope<unknown>): OutboxMessage {
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, event as unknown as Record<string, unknown>, new Date(event.occurredAt), 0);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state.id, state.aggregateId, state.eventType, state.payload, state.occurredAt, state.attempts, state.nextAttemptAt, state.publishedAt);
  }

  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
  get publishedAt(): Date | undefined { return this._publishedAt; }
  isPending(): boolean { return this._publishedAt === undefined; }
  isDue(now: Date): boolean { return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt <= now); }
  markPublished(at: Date): void { this._publishedAt = at; }

  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delaySeconds = Math.min(2 ** Math.min(this._attempts, 6), 60);
    this._nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);
  }
}
