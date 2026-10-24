export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: Omit<InboxMessageState, 'processedAt'>): InboxMessage {
    if (!props.messageId.trim() || !props.consumerName.trim()) throw new Error('INVALID_INBOX_ID');
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined { return this._processedAt; }
  isProcessed(): boolean { return this._processedAt !== undefined; }
  markProcessed(at: Date): void {
    if (this.isProcessed()) return;
    this._processedAt = at;
  }
}
