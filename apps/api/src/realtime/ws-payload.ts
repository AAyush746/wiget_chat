import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { WsAck, WsErrorCode, WsError } from '@chatflow/types';

/**
 * Ack/error plumbing for the gateway. The framework swallows exceptions
 * thrown from `@SubscribeMessage` handlers (it logs them and never invokes
 * the ack), so every failure is instead *returned*: acknowledged when the
 * client supplied a callback, pushed as an `error` event otherwise — a client
 * that emits without an ack still learns why its action failed.
 */
export type WsAckFn<T = unknown> = ((result: WsAck<T>) => void) | undefined;

/** The slice of a Socket.IO socket these helpers need. */
export interface WsErrorEmitter {
  emit(event: 'error', payload: { error: WsError }): void;
}

export function wsError(code: WsErrorCode, message: string): WsError {
  return { code, message };
}

export function respond<T>(socket: WsErrorEmitter, ack: WsAckFn<T>, result: WsAck<T>): void {
  if (typeof ack === 'function') {
    ack(result);
  } else if (result.ok === false) {
    socket.emit('error', { error: result.error });
  }
}

export function respondOk<T>(socket: WsErrorEmitter, ack: WsAckFn<T>, payload: T): void {
  respond(socket, ack, { ok: true, ...payload } as WsAck<T>);
}

export function respondError<T>(
  socket: WsErrorEmitter,
  ack: WsAckFn<T>,
  code: WsErrorCode,
  message: string,
): void {
  respond(socket, ack, { ok: false, error: wsError(code, message) });
}

/**
 * HTTP-pipe-equivalent validation for WebSocket payloads: whitelist +
 * forbidNonWhitelisted mirror the global ValidationPipe, so an unexpected
 * field (e.g. a forged `senderType`) or a wrong-typed value is rejected
 * before it can reach any service. Throws `WsPayloadError` with all
 * messages; the caller maps it to a `VALIDATION` ack.
 */
export class WsPayloadError extends Error {
  constructor(readonly messages: string[]) {
    super(messages.join('; '));
    this.name = 'WsPayloadError';
  }
}

export async function validateWsPayload<T extends object>(
  dtoClass: new () => T,
  payload: unknown,
): Promise<T> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new WsPayloadError(['payload must be an object']);
  }

  const instance = plainToInstance(dtoClass, payload);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const messages = errors.flatMap((error) =>
      Object.values(error.constraints ?? {}).map(
        (constraint) => `${error.property}: ${constraint}`,
      ),
    );
    throw new WsPayloadError(messages.length > 0 ? messages : ['invalid payload']);
  }

  return instance;
}
