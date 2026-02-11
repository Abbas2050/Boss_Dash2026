// Example: MT5 Integration with Existing Dashboard
// This shows how to add MT5 real-time data to your existing components

import { useMT5Account, useMT5User, useMT5UsersWithAccounts } from '@/hooks/useMT5';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Wallet, Users } from 'lucide-react';

/**
 * Example 1: MT5 Account Balance Card
 * Shows real-time balance and equity for a single MT5 account
 */
export function MT5AccountCard({ login }: { login: number }) {
  const { data, isLoading } = useMT5Account(login);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            MT5 Account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse h-20 bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }

  if (!data?.success || !data.data) {
    return null;
  }

  const account = data.data;
  const profitLoss = account.Equity - account.Balance;
  const isProfitable = profitLoss >= 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-5 w-5" />
          MT5 Account #{login}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Balance</p>
              <p className="text-2xl font-bold">
                ${account.Balance?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || '0.00'}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Equity</p>
              <p className="text-2xl font-bold text-green-600">
                ${account.Equity?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || '0.00'}
              </p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {isProfitable ? (
              <TrendingUp className="h-4 w-4 text-green-600" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-600" />
            )}
            <span className={`font-medium ${isProfitable ? 'text-green-600' : 'text-red-600'}`}>
              {isProfitable ? '+' : ''}{profitLoss.toFixed(2)} ({((profitLoss / account.Balance) * 100).toFixed(2)}%)
            </span>
          </div>

          <div className="pt-4 border-t">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-muted-foreground">Margin:</span>
                <span className="ml-2 font-medium">${account.Margin?.toLocaleString() || '0'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Free:</span>
                <span className="ml-2 font-medium">${account.MarginFree?.toLocaleString() || '0'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Level:</span>
                <span className="ml-2 font-medium">{account.MarginLevel?.toFixed(2) || '0'}%</span>
              </div>
              <div>
                <span className="text-muted-foreground">Leverage:</span>
                <span className="ml-2 font-medium">1:{account.Leverage || '0'}</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Example 2: MT5 User Info Widget
 * Shows user details from MT5
 */
export function MT5UserInfo({ login }: { login: number }) {
  const { data, isLoading } = useMT5User(login);

  if (isLoading || !data?.success || !data.data) {
    return null;
  }

  const user = data.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trader Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div>
            <p className="text-sm text-muted-foreground">Name</p>
            <p className="font-medium">{user.Name || 'N/A'}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Email</p>
            <p className="font-medium">{user.Email || 'N/A'}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Group</p>
            <Badge>{user.Group || 'N/A'}</Badge>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Country</p>
            <p className="font-medium">{user.Country || 'N/A'}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Example 3: MT5 Accounts Summary Table
 * Shows multiple accounts in a table format
 */
export function MT5AccountsTable({ logins }: { logins: number[] }) {
  const { data, isLoading } = useMT5UsersWithAccounts(logins);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="animate-pulse space-y-2">
            <div className="h-4 bg-muted rounded w-full" />
            <div className="h-4 bg-muted rounded w-full" />
            <div className="h-4 bg-muted rounded w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data?.success || !data.data) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-muted-foreground">No accounts found</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          MT5 Accounts Overview
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b">
                <th className="text-left p-2">Login</th>
                <th className="text-left p-2">Name</th>
                <th className="text-left p-2">Group</th>
                <th className="text-right p-2">Balance</th>
                <th className="text-right p-2">Equity</th>
                <th className="text-right p-2">P/L</th>
                <th className="text-right p-2">Margin Level</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map(({ user, account }) => {
                const pl = account.Equity - account.Balance;
                const isProfitable = pl >= 0;
                
                return (
                  <tr key={user.Login} className="border-b hover:bg-muted/50">
                    <td className="p-2 font-mono">{user.Login}</td>
                    <td className="p-2">{user.Name || 'N/A'}</td>
                    <td className="p-2">
                      <Badge variant="outline">{user.Group || 'N/A'}</Badge>
                    </td>
                    <td className="p-2 text-right font-medium">
                      ${account.Balance?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || '0.00'}
                    </td>
                    <td className="p-2 text-right font-medium">
                      ${account.Equity?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || '0.00'}
                    </td>
                    <td className={`p-2 text-right font-medium ${isProfitable ? 'text-green-600' : 'text-red-600'}`}>
                      {isProfitable ? '+' : ''}{pl.toFixed(2)}
                    </td>
                    <td className="p-2 text-right">
                      {account.MarginLevel?.toFixed(2) || '0'}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Example 4: Mini MT5 Stats Widget
 * Compact widget showing key metrics
 */
export function MT5MiniStats({ login }: { login: number }) {
  const { data } = useMT5Account(login);

  if (!data?.success || !data.data) return null;

  const account = data.data;

  return (
    <div className="grid grid-cols-3 gap-4">
      <div className="bg-blue-50 dark:bg-blue-950 rounded-lg p-3">
        <p className="text-xs text-muted-foreground">Balance</p>
        <p className="text-lg font-bold text-blue-600 dark:text-blue-400">
          ${(account.Balance / 1000).toFixed(1)}K
        </p>
      </div>
      <div className="bg-green-50 dark:bg-green-950 rounded-lg p-3">
        <p className="text-xs text-muted-foreground">Equity</p>
        <p className="text-lg font-bold text-green-600 dark:text-green-400">
          ${(account.Equity / 1000).toFixed(1)}K
        </p>
      </div>
      <div className="bg-purple-50 dark:bg-purple-950 rounded-lg p-3">
        <p className="text-xs text-muted-foreground">Margin Level</p>
        <p className="text-lg font-bold text-purple-600 dark:text-purple-400">
          {account.MarginLevel?.toFixed(0)}%
        </p>
      </div>
    </div>
  );
}

/**
 * Example 5: How to use in your existing Index.tsx
 * 
 * Add this to your Index.tsx file:
 */

/*
import { MT5AccountCard, MT5AccountsTable } from '@/components/dashboard/MT5Examples';

function Index() {
  // Your existing state...
  
  // Example: Track specific MT5 accounts
  const mt5Logins = [12345, 67890, 11111]; // Replace with your actual logins
  
  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />
      
      <main className="p-6 space-y-5">
        <FilterSection ... />
        
        <QuickStats ... />
        
        {/* Add MT5 Account Card * /}
        <MT5AccountCard login={12345} />
        
        {/* Add MT5 Accounts Table * /}
        <MT5AccountsTable logins={mt5Logins} />
        
        {/* Your existing components * /}
        <DealingDepartment ... />
        <AccountsDepartment ... />
        ...
      </main>
    </div>
  );
}
*/
