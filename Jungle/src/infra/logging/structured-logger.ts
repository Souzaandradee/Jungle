import { Injectable } from '@nestjs/common';

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

@Injectable()
export class StructuredLogger {
  info(message: string, context: LogContext = {}): void { this.write('info', message, context); }
  warn(message: string, context: LogContext = {}): void { this.write('warn', message, context); }
  error(message: string, context: LogContext = {}): void { this.write('error', message, context); }

  private write(level: string, message: string, context: LogContext): void {
    // Chaves fixas (com null quando ausentes) facilitam consultas consistentes nos logs JSON.
    // Explicitly keep full financial request/response payloads out of logs.
    const record = {
      ...context,
      timestamp: new Date().toISOString(),
      level,
      message,
      correlationId: context.correlationId ?? null,
      messageId: context.messageId ?? null,
      transactionId: context.transactionId ?? null,
      walletId: context.walletId ?? null,
      providerId: context.providerId ?? null,
    };
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}
