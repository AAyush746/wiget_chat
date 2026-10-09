import { useQueryClient } from '@tanstack/react-query';
import { useChatSocketEvents } from '../hooks/useChatSocket';
import {
  handleConversationClosed,
  handleConversationUpdated,
  handleMessageNew,
} from '../lib/realtime';

/**
 * Single global listener for pushed socket events → cache reconciliation.
 * Components read authoritative REST state from React Query; this is the one
 * place realtime events are applied (as *updates to existing* cache entries).
 */
export function RealtimeSync({ websiteId }: { websiteId: string | null }) {
  const queryClient = useQueryClient();

  useChatSocketEvents((event) => {
    switch (event.type) {
      case 'message:new':
        handleMessageNew(queryClient, websiteId, event.payload);
        break;
      case 'conversation:updated':
        handleConversationUpdated(queryClient, websiteId, event.payload);
        break;
      case 'conversation:closed':
        handleConversationClosed(queryClient, websiteId, event.payload);
        break;
      default:
        break;
    }
  });

  return null;
}
