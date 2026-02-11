// React Hook for MT5 Data
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  pingMT5,
  getMT5User,
  getMT5Users,
  getMT5Account,
  getMT5Trades,
  getMT5UsersWithAccounts,
} from '@/lib/mt5Api';
import type { MT5UsersRequest, MT5TradesRequest } from '@/lib/mt5Types';

/**
 * Hook to test MT5 connection
 */
export function useMT5Ping() {
  return useQuery({
    queryKey: ['mt5', 'ping'],
    queryFn: pingMT5,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to fetch single MT5 user
 */
export function useMT5User(login: number | null) {
  return useQuery({
    queryKey: ['mt5', 'user', login],
    queryFn: () => getMT5User(login!),
    enabled: !!login,
    staleTime: 2 * 60 * 1000, // 2 minutes
  });
}

/**
 * Hook to fetch multiple MT5 users
 */
export function useMT5Users(logins: number[]) {
  return useQuery({
    queryKey: ['mt5', 'users', logins.sort().join(',')],
    queryFn: () => getMT5Users({ logins }),
    enabled: logins.length > 0,
    staleTime: 2 * 60 * 1000,
  });
}

/**
 * Hook to fetch MT5 account details
 */
export function useMT5Account(login: number | null) {
  return useQuery({
    queryKey: ['mt5', 'account', login],
    queryFn: () => getMT5Account(login!),
    enabled: !!login,
    staleTime: 30 * 1000, // 30 seconds - more frequent updates for account data
    refetchInterval: 60 * 1000, // Auto-refresh every minute
  });
}

/**
 * Hook to fetch MT5 trades
 */
export function useMT5Trades(request: MT5TradesRequest | null) {
  return useQuery({
    queryKey: ['mt5', 'trades', request?.login, request?.from, request?.to],
    queryFn: () => getMT5Trades(request!),
    enabled: !!request?.login,
    staleTime: 60 * 1000, // 1 minute
  });
}

/**
 * Hook to fetch users with their account details
 */
export function useMT5UsersWithAccounts(logins: number[]) {
  return useQuery({
    queryKey: ['mt5', 'users-with-accounts', logins.sort().join(',')],
    queryFn: () => getMT5UsersWithAccounts(logins),
    enabled: logins.length > 0,
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000, // Auto-refresh every 5 minutes
  });
}

/**
 * Hook to manually refresh MT5 data
 */
export function useMT5Refresh() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (queryKeys?: string[]) => {
      if (queryKeys) {
        // Refresh specific queries
        queryKeys.forEach(key => {
          queryClient.invalidateQueries({ queryKey: ['mt5', key] });
        });
      } else {
        // Refresh all MT5 queries
        queryClient.invalidateQueries({ queryKey: ['mt5'] });
      }
    },
  });
}

/**
 * Hook to get real-time account updates
 * Uses polling for live balance/equity updates
 */
export function useMT5LiveAccount(login: number | null, interval = 10000) {
  return useQuery({
    queryKey: ['mt5', 'live-account', login],
    queryFn: () => getMT5Account(login!),
    enabled: !!login,
    refetchInterval: interval,
    staleTime: 0, // Always consider stale for real-time updates
  });
}
