import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import { Prisma } from '@prisma/client';

interface HttpResponseLike {
  status(code: number): { json(body: unknown): void };
}

interface HttpRequestLike {
  method: string;
  url: string;
}

/**
 * Last-resort exception filter. HttpExceptions keep their status/response;
 * known Prisma errors are mapped to safe statuses; anything else is logged
 * server-side and returned as a generic 500 so stack traces, Prisma codes and
 * internal messages are never leaked to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<HttpResponseLike>();
    const request = ctx.getRequest<HttpRequestLike>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response
        .status(status)
        .json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = this.mapPrismaError(exception);
      if (mapped) {
        response.status(mapped.status).json(mapped.body);
        return;
      }
    }

    this.logger.error(
      `Unhandled exception on ${request.method} ${request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }

  private mapPrismaError(error: Prisma.PrismaClientKnownRequestError): {
    status: number;
    body: { statusCode: number; message: string };
  } | null {
    switch (error.code) {
      case 'P2002':
        return { status: 409, body: { statusCode: 409, message: 'Resource already exists' } };
      case 'P2025':
        return { status: 404, body: { statusCode: 404, message: 'Resource not found' } };
      default:
        return null;
    }
  }
}
