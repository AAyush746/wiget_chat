import { useEffect, useRef, useSyncExternalStore } from 'react';
import { chatSocket, type ChatSocketEvent, type SocketStatus } from '../lib/socket';

/** Live connection status (via `useSyncExternalStore`, no re-render storms). */
export function useSocketStatus(): SocketStatus {
  return useSyncExternalStore(
    (onStoreChange) => chatSocket.subscribe(() => onStoreChange()),
    () => chatSocket.getState(),
  );
}

/**
 * Subscribe a handler to socket events once. The handler is kept in a ref so
 * re-renders never churn listeners; the subscription itself is
 * mount/unmount-scoped (StrictMode-safe).
 */
export function useChatSocketEvents(handler: (event: ChatSocketEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => chatSocket.subscribe((event) => ref.current(event)), []);
}
