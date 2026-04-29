import React, { useMemo, useState } from 'react';
import { DepartmentCard } from './DepartmentCard';
import { useAccountAlerts } from '@/hooks/useAccountAlerts';
import { Zap } from 'lucide-react';

function short(val: any, max = 40) {
  if (val == null) return '-';
  if (typeof val === 'number') return val.toLocaleString();
  const s = String(val);
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

export const AccountAlerts: React.FC = () => {
  const { status, lastError, userEvents, marginEvents, allEvents, counts } = useAccountAlerts();
  const [tab, setTab] = useState<'users' | 'margin' | 'all'>('all');

  const summary = useMemo(() => ({
    adds: counts.Add || 0,
    updates: counts.Update || 0,
    deletes: counts.Delete || 0,
    marginCalls: counts.MarginCallEnter || 0,
    stopOuts: counts.StopOutEnter || 0,
  }), [counts]);

  return (
    <DepartmentCard title="Account Alerts" icon={Zap} accentColor="primary">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className={`px-2 py-1 rounded text-xs ${status === 'connected' ? 'bg-success/10 text-success' : status === 'connecting' || status === 'reconnecting' ? 'bg-warning/10 text-warning' : 'bg-destructive/10 text-destructive'}`}>
            {status === 'connected' ? 'WS Connected' : status === 'connecting' ? 'WS Connecting' : status === 'reconnecting' ? 'WS Reconnecting' : 'WS Disconnected'}
          </div>
          <div className="text-xs text-muted-foreground">Users: {userEvents.length}</div>
          <div className="text-xs text-muted-foreground">Alerts: {marginEvents.length}</div>
          <div className="text-xs text-muted-foreground">All: {allEvents.length}</div>
        </div>
        {lastError && <div className="max-w-full text-[11px] text-destructive sm:ml-2">{String(lastError).slice(0,160)}</div>}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <button className={`px-2 py-1 text-xs rounded ${tab === 'all' ? 'bg-primary/20 text-primary' : 'bg-secondary/20 text-muted-foreground'}`} onClick={() => setTab('all')}>All</button>
        <button className={`px-2 py-1 text-xs rounded ${tab === 'users' ? 'bg-primary/20 text-primary' : 'bg-secondary/20 text-muted-foreground'}`} onClick={() => setTab('users')}>User Changes</button>
        <button className={`px-2 py-1 text-xs rounded ${tab === 'margin' ? 'bg-primary/20 text-primary' : 'bg-secondary/20 text-muted-foreground'}`} onClick={() => setTab('margin')}>Margin/Stopout</button>
      </div>

      <div className="grid grid-cols-1 gap-3 pt-3 sm:grid-cols-2">
        <div className="p-2 rounded-md bg-secondary/10 border border-border/30 text-xs">
          <div className="text-muted-foreground">New Accounts</div>
          <div className="font-mono font-semibold text-lg text-success">{summary.adds}</div>
        </div>
        <div className="p-2 rounded-md bg-secondary/10 border border-border/30 text-xs">
          <div className="text-muted-foreground">Updates</div>
          <div className="font-mono font-semibold text-lg">{summary.updates}</div>
        </div>
        <div className="p-2 rounded-md bg-secondary/10 border border-border/30 text-xs">
          <div className="text-muted-foreground">Deleted</div>
          <div className="font-mono font-semibold text-lg text-destructive">{summary.deletes}</div>
        </div>
        <div className="p-2 rounded-md bg-secondary/10 border border-border/30 text-xs">
          <div className="text-muted-foreground">Margin Calls</div>
          <div className="font-mono font-semibold text-lg text-warning">{summary.marginCalls}</div>
        </div>
      </div>

      <div className="max-h-64 overflow-auto border-t border-border/30 pt-3">
        {tab === 'users' && (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-xs">
            <thead>
              <tr className="text-left text-muted-foreground"><th>Time</th><th>Event</th><th>Login</th><th>Name</th><th>Group</th><th>Balance</th></tr>
            </thead>
            <tbody>
              {userEvents.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">No user changes yet</td></tr>}
              {userEvents.map((e, i) => (
                <tr key={i} className={i===0?'live-row':''}>
                  <td className="align-top pr-3">{short(e.time)}</td>
                  <td className="align-top pr-3"><span className={`badge ${e.eventType==='Add'?'badge-add':e.eventType==='Update'?'badge-update':'badge-delete'}`}>{e.eventType}</span></td>
                  <td className="align-top pr-3">{short(e.login)}</td>
                  <td className="align-top pr-3">{short(e.name)}</td>
                  <td className="align-top pr-3">{short(e.group)}</td>
                  <td className="align-top pr-3">{e.balance!=null?Number(e.balance).toFixed(2):'-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {tab === 'margin' && (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-xs">
            <thead>
              <tr className="text-left text-muted-foreground"><th>Time</th><th>Type</th><th>Login</th><th>Equity</th><th>Balance</th><th>Margin</th></tr>
            </thead>
            <tbody>
              {marginEvents.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">No margin alerts yet</td></tr>}
              {marginEvents.map((e, i) => (
                <tr key={i} className={i===0?'live-row':''}>
                  <td className="pr-3">{short(e.time)}</td>
                  <td className="pr-3"><span className={`badge ${e.alertType?.includes('StopOut')?'badge-stop-out':'badge-margin-call'}`}>{e.alertType}</span></td>
                  <td className="pr-3">{short(e.account?.login)}</td>
                  <td className="pr-3">{short(e.account?.equity)}</td>
                  <td className="pr-3">{short(e.account?.balance)}</td>
                  <td className="pr-3">{short(e.account?.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {tab === 'all' && (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-xs">
            <thead>
              <tr className="text-left text-muted-foreground"><th>Time</th><th>Type</th><th>Login</th><th>Name/Group</th><th>Details</th></tr>
            </thead>
            <tbody>
              {allEvents.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">No alerts yet</td></tr>}
              {allEvents.map((e, i) => (
                <tr key={i} className={i===0?'live-row':''}>
                  <td className="pr-3">{short(e.time)}</td>
                  <td className="pr-3">{short(e.type)}</td>
                  <td className="pr-3">{short(e.login)}</td>
                  <td className="pr-3">{short(e.nameGroup, 80)}</td>
                  <td className="pr-3">{short(e.details, 240)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </DepartmentCard>
  );
}

export default AccountAlerts;
