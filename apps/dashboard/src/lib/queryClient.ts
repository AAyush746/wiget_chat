import { QueryClient } from '@tanstack/react-query';

/**
 * Application-wide query client, centralized so it can be cleared on logout.
 * Server data is tenant-scoped; keeping it across sessions could briefly
 * surface a previous user's data, so logout wipes the entire cache.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});
