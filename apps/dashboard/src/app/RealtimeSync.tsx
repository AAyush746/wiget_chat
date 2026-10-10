import { useQueryClient } from '@tanstack/react-query';
import { useChatSocketEvents } from '../hooks/useChatSocket';
import {
  handleConversationAssigned,
  handleConversationClosed,
  handleConversationNew,
  handleConversationUpdated,
  handleMessageNew,
} from '../lib/realtime';

/**
 * Single global listener for pushed socket events → cache reconciliation.
 * Components read authoritative REST state from React Query; this is the one
 * place realtime events are applied (as *updates to existing* cache entries,
 * or a background refetch when an event cannot be placed into the cache).
 *
 * A `reconnected` signal re-syncs everything for the active website: REST
 * queries are refetched so state lost during the drop (missed events, drifted
 * ordering) is replaced by the server's truth.
 */
export function RealtimeSync({ websiteId }: { websiteId: string | null }) {
  const queryClient = useQueryClient();

  useChatSocketEvents((event) => {
    switch (event.type) {
      case 'conversation:new':
        handleConversationNew(queryClient, event.payload);
        break;
      case 'message:new':
        handleMessageNew(queryClient, websiteId, event.payload);
        break;
      case 'conversation:updated':
        handleConversationUpdated(queryClient, websiteId, event.payload);
        break;
      case 'conversation:closed':
        handleConversationClosed(queryClient, websiteId, event.payload);
        break;
      case 'conversation:assigned':
        handleConversationAssigned(queryClient, websiteId, event.payload);
        break;
      case 'reconnected':
        if (websiteId !== null) {
          queryClient.invalidateQueries({ queryKey: ['conversations', websiteId] });
          queryClient.invalidateQueries({ queryKey: ['conversation', websiteId] });
          queryClient.invalidateQueries({ queryKey: ['messages', websiteId] });
        }
        break;
      default:
        break;
    }
  });

  return null;
}
