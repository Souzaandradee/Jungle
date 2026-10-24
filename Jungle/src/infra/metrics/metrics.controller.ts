import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  async read(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', this.metrics.contentType());
    response.send(await this.metrics.metrics());
  }
}
