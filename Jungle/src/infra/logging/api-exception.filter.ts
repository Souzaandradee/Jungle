import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StructuredLogger } from './structured-logger';

@Catch()
@Injectable()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const transient = isTransientInfrastructureError(exception);
    const httpException = asHttpException(exception);
    const status = httpException
      ? httpException.getStatus()
      : transient ? 503 : 500;

    this.logger.error('http_request_failed', {
      correlationId: firstHeader(request.headers['x-correlation-id']) ?? randomUUID(),
      transactionId: request.params?.transactionId,
      walletId: request.params?.walletId,
      providerId: request.params?.providerId,
      status,
      errorName: exception instanceof Error ? exception.name : 'UnknownError',
    });

    if (httpException) {
      response.status(status).json(httpException.getResponse());
      return;
    }

    if (transient) {
      response.status(503).json({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Transient infrastructure failure. Retry with the same Idempotency-Key.',
      });
      return;
    }

    response.status(500).json({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Unexpected server error.',
    });
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const result = Array.isArray(value) ? value[0] : value;
  return result?.slice(0, 128) || undefined;
}

function isTransientInfrastructureError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if ('code' in current) {
      const code = String((current as { code?: unknown }).code ?? '');
      if (code.startsWith('08') || [
        'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
        '57P01', '57P02', '57P03', '53300', '40001', '40P01',
      ].includes(code)) return true;
    }
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

interface HttpExceptionLike extends Error {
  getStatus(): number;
  getResponse(): string | object;
}

function asHttpException(error: unknown): HttpExceptionLike | undefined {
  if (!(error instanceof Error) || !('getStatus' in error) || !('getResponse' in error)) return undefined;
  const candidate = error as Error & { getStatus?: unknown; getResponse?: unknown };
  if (typeof candidate.getStatus !== 'function' || typeof candidate.getResponse !== 'function') return undefined;
  return error as HttpExceptionLike;
}
