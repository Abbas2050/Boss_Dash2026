import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  useMT5Ping,
  useMT5User,
  useMT5Account,
  useMT5Trades,
  useMT5UsersWithAccounts,
  useMT5Refresh,
} from '@/hooks/useMT5';
import { Loader2, RefreshCw, CheckCircle2, XCircle, TrendingUp } from 'lucide-react';

export function MT5Dashboard() {
  const [loginInput, setLoginInput] = useState('');
  const [selectedLogin, setSelectedLogin] = useState<number | null>(null);
  const [multipleLogins, setMultipleLogins] = useState<number[]>([]);

  // Test connection
  const { data: pingData, isLoading: pingLoading } = useMT5Ping();

  // Single user query
  const { data: userData, isLoading: userLoading, error: userError } = useMT5User(selectedLogin);

  // Account query
  const { data: accountData, isLoading: accountLoading } = useMT5Account(selectedLogin);

  // Trades query
  const { data: tradesData, isLoading: tradesLoading } = useMT5Trades(
    selectedLogin ? { login: selectedLogin } : null
  );

  // Multiple users query
  const { data: usersData, isLoading: usersLoading } = useMT5UsersWithAccounts(multipleLogins);

  // Refresh mutation
  const refreshMutation = useMT5Refresh();

  const handleSearch = () => {
    const login = parseInt(loginInput);
    if (!isNaN(login)) {
      setSelectedLogin(login);
    }
  };

  const handleRefresh = () => {
    refreshMutation.mutate(undefined);
  };

  return (
    <div className="space-y-6 p-6">
      {/* Connection Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            MT5 Connection Status
            <Button
              size="sm"
              variant="outline"
              onClick={handleRefresh}
              disabled={refreshMutation.isPending}
            >
              <RefreshCw className={`h-4 w-4 ${refreshMutation.isPending ? 'animate-spin' : ''}`} />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pingLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Checking connection...</span>
            </div>
          ) : pingData?.success ? (
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-semibold">Connected to MT5 Server</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-red-600">
              <XCircle className="h-5 w-5" />
              <span className="font-semibold">Connection Failed</span>
              {pingData?.error && <span className="text-sm">- {pingData.error}</span>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Search User */}
      <Card>
        <CardHeader>
          <CardTitle>Search MT5 Account</CardTitle>
          <CardDescription>Enter an MT5 login number to view account details</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <div className="flex-1">
              <Label htmlFor="login">MT5 Login</Label>
              <Input
                id="login"
                type="number"
                placeholder="Enter login number"
                value={loginInput}
                onChange={(e) => setLoginInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
            <Button onClick={handleSearch} className="mt-6">
              Search
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* User Details */}
      {selectedLogin && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>User Information - Login: {selectedLogin}</CardTitle>
            </CardHeader>
            <CardContent>
              {userLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading user data...</span>
                </div>
              ) : userError ? (
                <Alert variant="destructive">
                  <AlertDescription>Error loading user data</AlertDescription>
                </Alert>
              ) : userData?.success && userData.data ? (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">Name</Label>
                    <p className="font-medium">{userData.data.Name || 'N/A'}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Email</Label>
                    <p className="font-medium">{userData.data.Email || 'N/A'}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Group</Label>
                    <p className="font-medium">{userData.data.Group || 'N/A'}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Country</Label>
                    <p className="font-medium">{userData.data.Country || 'N/A'}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Balance</Label>
                    <p className="font-medium text-lg">
                      ${userData.data.Balance?.toLocaleString() || '0.00'}
                    </p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Credit</Label>
                    <p className="font-medium text-lg">
                      ${userData.data.Credit?.toLocaleString() || '0.00'}
                    </p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Leverage</Label>
                    <p className="font-medium">1:{userData.data.Leverage || 'N/A'}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Currency</Label>
                    <p className="font-medium">{userData.data.Currency || 'N/A'}</p>
                  </div>
                </div>
              ) : (
                <Alert variant="destructive">
                  <AlertDescription>{userData?.error || 'Failed to load user'}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {/* Account Details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Live Account Details
              </CardTitle>
              <CardDescription>Real-time account information</CardDescription>
            </CardHeader>
            <CardContent>
              {accountLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading account data...</span>
                </div>
              ) : accountData?.success && accountData.data ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
                      <Label className="text-muted-foreground text-sm">Balance</Label>
                      <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                        ${accountData.data.Balance?.toLocaleString() || '0.00'}
                      </p>
                    </div>
                    <div className="p-4 bg-green-50 dark:bg-green-950 rounded-lg">
                      <Label className="text-muted-foreground text-sm">Equity</Label>
                      <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                        ${accountData.data.Equity?.toLocaleString() || '0.00'}
                      </p>
                    </div>
                    <div className="p-4 bg-purple-50 dark:bg-purple-950 rounded-lg">
                      <Label className="text-muted-foreground text-sm">Margin Free</Label>
                      <p className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                        ${accountData.data.MarginFree?.toLocaleString() || '0.00'}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-muted-foreground">Margin Level</Label>
                      <p className="font-medium text-lg">
                        {accountData.data.MarginLevel?.toFixed(2) || '0.00'}%
                      </p>
                    </div>
                    <div>
                      <Label className="text-muted-foreground">Margin Used</Label>
                      <p className="font-medium text-lg">
                        ${accountData.data.Margin?.toLocaleString() || '0.00'}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <Alert variant="destructive">
                  <AlertDescription>
                    {accountData?.error || 'Failed to load account'}
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {/* Trades */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Trades</CardTitle>
            </CardHeader>
            <CardContent>
              {tradesLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading trades...</span>
                </div>
              ) : tradesData?.success && tradesData.data ? (
                <div className="text-sm text-muted-foreground">
                  {Array.isArray(tradesData.data) && tradesData.data.length > 0 ? (
                    <p>{tradesData.data.length} trades found</p>
                  ) : (
                    <p>No trades found</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No trades available</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
