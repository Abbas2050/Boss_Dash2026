import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  batchUpdateLeverage,
  type LeverageUpdateRequest,
  type LeverageUpdateResult,
} from '@/lib/api';
import { Loader2, CheckCircle2, XCircle, Upload } from 'lucide-react';

export function LeverageUpdateTool() {
  const [inputText, setInputText] = useState('');
  const [leverage, setLeverage] = useState('100');
  const [parsedAccounts, setParsedAccounts] = useState<LeverageUpdateRequest[]>([]);
  const [results, setResults] = useState<LeverageUpdateResult[]>([]);

  // Parse input - supports multiple formats
  const parseAccounts = (text: string) => {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    const accounts: LeverageUpdateRequest[] = [];

    for (const line of lines) {
      // Format 1: "serverId login" (space-separated)
      // Format 2: "serverId-login" (hyphen-separated)
      // Format 3: CSV format with headers
      const parts = line
        .split(/[\s,-]+/)
        .map((p) => p.trim())
        .filter((p) => p);

      if (parts.length >= 2) {
        const serverId = parseInt(parts[0]);
        const login = parts[1];

        if (!isNaN(serverId) && login) {
          accounts.push({
            serverId,
            login,
            leverage: parseInt(leverage),
          });
        }
      }
    }

    return accounts;
  };

  const handleParse = () => {
    const accounts = parseAccounts(inputText);
    setParsedAccounts(accounts);
    setResults([]);
  };

  // Mutation for batch update
  const updateMutation = useMutation({
    mutationFn: async () => {
      if (parsedAccounts.length === 0) {
        throw new Error('No accounts to update');
      }
      return await batchUpdateLeverage(parsedAccounts);
    },
    onSuccess: (data) => {
      setResults(data);
    },
  });

  const handleUpdateAll = async () => {
    if (parsedAccounts.length === 0) {
      alert('Please parse accounts first');
      return;
    }

    if (!confirm(`Update leverage to ${leverage} for ${parsedAccounts.length} account(s)?`)) {
      return;
    }

    updateMutation.mutate();
  };

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.filter((r) => !r.success).length;

  // Example data
  const exampleInput = `# Paste your accounts here (format: serverId login or serverId-login)
# Example:
2 101610
2 101611
2-101612`;

  return (
    <div className="space-y-6 p-6">
      {/* Input Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            1. Account List
          </CardTitle>
          <CardDescription>
            Enter accounts in format: serverId login (one per line) or use serverId-login format
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="accounts">Accounts</Label>
            <Textarea
              id="accounts"
              placeholder={exampleInput}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              rows={8}
              className="font-mono text-sm"
            />
          </div>

          <div className="flex gap-4">
            <div className="flex-1">
              <Label htmlFor="leverage">New Leverage</Label>
              <Input
                id="leverage"
                type="number"
                value={leverage}
                onChange={(e) => setLeverage(e.target.value)}
                min="1"
                max="500"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Value between 1 and 500
              </p>
            </div>
          </div>

          <Button onClick={handleParse} className="w-full">
            Parse Accounts
          </Button>
        </CardContent>
      </Card>

      {/* Parsed Accounts Review */}
      {parsedAccounts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>2. Review Accounts</span>
              <Badge variant="outline">{parsedAccounts.length} accounts</Badge>
            </CardTitle>
            <CardDescription>
              Review the parsed accounts before updating. New leverage: {leverage}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Server ID</TableHead>
                    <TableHead>Login</TableHead>
                    <TableHead>New Leverage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedAccounts.slice(0, 10).map((account, idx) => (
                    <TableRow key={idx}>
                      <TableCell className="font-mono">{account.serverId}</TableCell>
                      <TableCell className="font-mono">{account.login}</TableCell>
                      <TableCell>
                        <Badge>1:{account.leverage}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {parsedAccounts.length > 10 && (
              <p className="text-sm text-muted-foreground mt-4">
                ... and {parsedAccounts.length - 10} more accounts
              </p>
            )}

            <Button
              onClick={handleUpdateAll}
              disabled={updateMutation.isPending}
              className="w-full mt-6"
              size="lg"
            >
              {updateMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {updateMutation.isPending
                ? 'Updating...'
                : `Update ${parsedAccounts.length} Accounts`}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Results Section */}
      {results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>3. Update Results</span>
              <div className="flex gap-2">
                <Badge variant="outline" className="bg-green-50 text-green-700">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  {successCount} Success
                </Badge>
                {failureCount > 0 && (
                  <Badge variant="outline" className="bg-red-50 text-red-700">
                    <XCircle className="h-3 w-3 mr-1" />
                    {failureCount} Failed
                  </Badge>
                )}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {results.map((result, idx) => (
                <div
                  key={idx}
                  className={`p-3 rounded border ${
                    result.success
                      ? 'bg-green-50 border-green-200'
                      : 'bg-red-50 border-red-200'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      {result.success ? (
                        <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
                      )}
                      <div>
                        <p className="font-mono font-semibold">
                          {result.serverId}-{result.login}
                        </p>
                        {result.success ? (
                          <p className="text-sm text-green-700">
                            ✓ Leverage updated to 1:{result.newLeverage}
                          </p>
                        ) : (
                          <p className="text-sm text-red-700">{result.error}</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Summary Stats */}
            <div className="mt-6 grid grid-cols-3 gap-4">
              <div className="p-3 bg-blue-50 rounded text-center">
                <p className="text-sm text-muted-foreground">Total Processed</p>
                <p className="text-2xl font-bold">{results.length}</p>
              </div>
              <div className="p-3 bg-green-50 rounded text-center">
                <p className="text-sm text-muted-foreground">Successful</p>
                <p className="text-2xl font-bold text-green-600">{successCount}</p>
              </div>
              <div className="p-3 bg-red-50 rounded text-center">
                <p className="text-sm text-muted-foreground">Failed</p>
                <p className="text-2xl font-bold text-red-600">{failureCount}</p>
              </div>
            </div>

            <Button
              onClick={() => {
                setInputText('');
                setParsedAccounts([]);
                setResults([]);
              }}
              variant="outline"
              className="w-full mt-6"
            >
              Clear & Reset
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Help Section */}
      <Card>
        <CardHeader>
          <CardTitle>📋 Input Format Guide</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <p className="font-semibold text-sm mb-2">Supported formats:</p>
            <div className="bg-muted p-3 rounded font-mono text-sm space-y-1">
              <p># Format 1: Space separated</p>
              <p>2 101610</p>
              <p>2 101611</p>
              <p className="mt-2"># Format 2: Hyphen separated</p>
              <p>2-101610</p>
              <p>2-101611</p>
              <p className="mt-2"># Format 3: CSV (future support)</p>
              <p>serverId,login</p>
            </div>
          </div>

          <Alert>
            <AlertDescription>
              ℹ️ Lines starting with # are treated as comments and ignored. Empty lines are also
              skipped.
            </AlertDescription>
          </Alert>

          <div>
            <p className="font-semibold text-sm mb-2">Example:</p>
            <div className="bg-muted p-3 rounded font-mono text-sm whitespace-pre-wrap">
              {exampleInput}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
