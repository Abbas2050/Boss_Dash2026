# React Migration Guidelines — SLC Dashboard

## Purpose
Use this document as a checklist when converting vanilla JS/HTML pages to React. Every pattern listed here must be checked and converted to its React equivalent. The goal is **simple, performant, well-optimized** code — no over-engineering.

---

## 1. DOM Manipulation → JSX + State

### What to look for
- `document.getElementById()`, `document.querySelector()`, `document.querySelectorAll()`
- `element.innerHTML = ...`, `element.textContent = ...`
- `element.style.display = ...`, `element.classList.add/remove/toggle()`
- `element.setAttribute()`, `element.removeAttribute()`
- `element.appendChild()`, `element.removeChild()`, `element.insertBefore()`
- `document.createElement()`, `element.cloneNode()`

### React equivalent
```jsx
// BAD — vanilla DOM
document.getElementById('myTable').innerHTML = rows.map(r => `<tr><td>${r.name}</td></tr>`).join('');

// GOOD — React state drives rendering
const [rows, setRows] = useState([]);
return (
  <table>
    <tbody>
      {rows.map(r => <tr key={r.id}><td>{r.name}</td></tr>)}
    </tbody>
  </table>
);
```

### Rules
- **Never use `ref` to manipulate DOM** unless integrating a non-React library (e.g., chart)
- **Never use `dangerouslySetInnerHTML`** — always use JSX
- Conditional rendering via `{condition && <Component />}` or ternary, not `style.display`
- CSS classes via `className={condition ? 'active' : ''}` or `clsx()`/`classnames()`

---

## 2. Event Handling → React Events

### What to look for
- `element.addEventListener('click', handler)`
- `element.removeEventListener()`
- `element.onclick = ...`, `element.onchange = ...`
- Inline HTML: `onclick="doSomething()"`

### React equivalent
```jsx
// BAD
document.getElementById('btn').addEventListener('click', handleClick);

// GOOD
<button onClick={handleClick}>Run</button>
```

### Rules
- Use `onClick`, `onChange`, `onSubmit` etc. directly on JSX elements
- No manual cleanup needed — React handles event listener lifecycle
- For forms: use `onSubmit` with `e.preventDefault()`, not button click handlers
- Debounce expensive handlers with `useMemo` or a simple debounce utility

---

## 3. Data Fetching → Custom Hooks or React Query

### What to look for
- Raw `fetch()` or `XMLHttpRequest` calls in script tags
- Manual loading/error state management
- `setInterval` for polling
- Retry logic or caching implemented by hand

### React equivalent
```jsx
// Simple: custom hook
function useApiData(url) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [url]);

  return { data, loading, error, refetch: fetchData };
}
```

### Rules
- **One fetch pattern** across the whole app — either a shared `useApi` hook or React Query/TanStack Query
- Always handle loading + error states
- Use `AbortController` in `useEffect` cleanup to cancel in-flight requests on unmount
- For polling: `useEffect` with `setInterval` + cleanup, or React Query's `refetchInterval`
- Never fetch in render body — always in `useEffect` or event handlers

---

## 4. SignalR → Dedicated Hook

### What to look for (8 pages use SignalR)
- `new signalR.HubConnectionBuilder().withUrl('/ws/dashboard').build()`
- `connection.on('MethodName', callback)`
- `connection.start()`, reconnection logic
- Manual connection state tracking

### React equivalent
```jsx
// hooks/useSignalR.js — single shared hook
function useSignalR(methods) {
  const connectionRef = useRef(null);

  useEffect(() => {
    const conn = new signalR.HubConnectionBuilder()
      .withUrl('/ws/dashboard')
      .withAutomaticReconnect()
      .build();

    Object.entries(methods).forEach(([name, handler]) => {
      conn.on(name, handler);
    });

    conn.start().catch(console.error);
    connectionRef.current = conn;

    return () => { conn.stop(); };
  }, []); // methods should be stable refs

  return connectionRef;
}

// Usage
useSignalR({
  DealUpdate: (deal) => setDeals(prev => [...prev, deal]),
  PositionUpdate: (pos) => setPositions(pos),
});
```

### Rules
- **One SignalR connection** shared across components — use React context or a singleton
- Connection setup in `useEffect`, teardown in cleanup
- Handler references must be stable (`useCallback`) to avoid reconnection churn
- Reconnection is handled by `withAutomaticReconnect()` — no manual retry loops

---

## 5. Timers & Intervals → useEffect Cleanup

### What to look for
- `setInterval()`, `setTimeout()` without cleanup
- Auto-refresh patterns
- Countdown timers

### React equivalent
```jsx
useEffect(() => {
  const id = setInterval(() => fetchData(), 30000);
  return () => clearInterval(id);
}, [fetchData]);
```

### Rules
- **Every timer must have cleanup** in the `useEffect` return
- Never set intervals in event handlers without tracking the ID in a ref
- Prefer `useRef` for timer IDs if they need to be cleared from event handlers

---

## 6. localStorage / sessionStorage → Custom Hook

### What to look for
- `localStorage.getItem()`, `localStorage.setItem()`
- Manual JSON parse/stringify
- Settings persistence (column selections, filters, preferences)

### React equivalent
```jsx
function useLocalStorage(key, defaultValue) {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : defaultValue;
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

// Usage
const [selectedColumns, setSelectedColumns] = useLocalStorage('apiCols', DEFAULT_COLS);
```

---

## 7. Tables with Sorting/Filtering → Component Pattern

### What to look for
- Manual sort arrows, `element.classList` toggling for sort direction
- Filter inputs that rebuild table HTML
- `tbody.innerHTML = rows.join('')` patterns

### React equivalent
```jsx
function SortableTable({ data, columns }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    return [...data].sort((a, b) => {
      const v = a[sortKey] > b[sortKey] ? 1 : -1;
      return sortDir === 'asc' ? v : -v;
    });
  }, [data, sortKey, sortDir]);

  return (
    <table>
      <thead>
        <tr>
          {columns.map(col => (
            <th key={col.key} onClick={() => {
              setSortDir(sortKey === col.key && sortDir === 'asc' ? 'desc' : 'asc');
              setSortKey(col.key);
            }}>
              {col.label} {sortKey === col.key ? (sortDir === 'asc' ? '▲' : '▼') : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map(row => (
          <tr key={row.id}>
            {columns.map(col => <td key={col.key}>{col.render ? col.render(row) : row[col.key]}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### Rules
- Use `useMemo` for sorted/filtered data — don't re-sort on every render
- Column definitions as data, not hardcoded JSX
- For large tables (1000+ rows): use virtualization (`react-window` or `@tanstack/react-virtual`)

---

## 8. Tabs / Panels → Component State

### What to look for
- `document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none')`
- Manual class toggling for active tab
- Tab click handlers that show/hide divs

### React equivalent
```jsx
const [activeTab, setActiveTab] = useState('overview');

return (
  <>
    <div className="tabs">
      {['overview', 'details', 'fixApi'].map(tab => (
        <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => setActiveTab(tab)}>
          {tab}
        </button>
      ))}
    </div>
    {activeTab === 'overview' && <OverviewPanel />}
    {activeTab === 'details' && <DetailsPanel />}
    {activeTab === 'fixApi' && <FixApiPanel />}
  </>
);
```

---

## 9. Number / Date Formatting → Utility Functions

### What to look for
- Inline `.toFixed(2)`, `.toLocaleString()` scattered everywhere
- Manual date formatting with `getFullYear()`, `getMonth()`, etc.
- Repeated `if (val > 0) green else red` patterns

### React equivalent
```jsx
// utils/format.js — shared, pure functions
export const fmt = {
  number: (v, decimals = 2) => v?.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) ?? '—',
  currency: (v) => v?.toLocaleString(undefined, { style: 'currency', currency: 'USD' }) ?? '—',
  lots: (v) => v?.toFixed(2) ?? '0.00',
  date: (v) => v ? new Date(v).toLocaleDateString() : '—',
  dateTime: (v) => v ? new Date(v).toLocaleString() : '—',
  pnlClass: (v) => v > 0 ? 'positive' : v < 0 ? 'negative' : '',
};
```

### Rules
- All formatting in one `utils/format.js` file
- No formatting logic in JSX — call utility functions
- PnL coloring via CSS class, not inline styles

---

## 10. CSS / Styling

### What to look for
- `element.style.color = 'red'`, `element.style.display = 'none'`
- Inline style strings in template literals
- `<style>` blocks in HTML files

### React equivalent
- Use CSS modules (`*.module.css`) or a shared stylesheet
- Conditional classes: `className={clsx('row', { positive: val > 0, negative: val < 0 })}`
- Never use inline `style={}` except for truly dynamic values (e.g., width percentages)

---

## 11. Navigation / Shared Layout

### What to look for
- Copy-pasted nav bar HTML across all 24 pages
- `<a href="page.html">` links
- Active page highlighting via inline script

### React equivalent
```jsx
// components/Layout.jsx
function Layout({ children }) {
  return (
    <div className="app">
      <Sidebar />
      <main>{children}</main>
    </div>
  );
}

// Use React Router for navigation
<BrowserRouter>
  <Layout>
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/deal-matching" element={<DealMatching />} />
      <Route path="/client-profiling" element={<ClientProfiling />} />
    </Routes>
  </Layout>
</BrowserRouter>
```

### Rules
- **One shared layout** — nav bar, sidebar rendered once
- React Router for all navigation — no full page reloads
- Active link highlighting via `NavLink` component

---

## 12. Performance Checklist

- [ ] `useMemo` for expensive computations (sorting, filtering, aggregation)
- [ ] `useCallback` for handlers passed as props to child components
- [ ] `React.memo()` on components that receive the same props often
- [ ] Virtualize tables/lists with 500+ rows
- [ ] Lazy-load routes: `React.lazy(() => import('./pages/DealMatching'))`
- [ ] Avoid creating objects/arrays in JSX props (causes unnecessary re-renders)
- [ ] Keep state as close to where it's used as possible — don't lift state unnecessarily
- [ ] For SignalR/WebSocket data: batch state updates, don't setState on every message if rendering can't keep up

---

## 13. Anti-Patterns to Reject

| Vanilla JS Pattern | Why It's Wrong in React | Correct React Way |
|---|---|---|
| `document.getElementById` | Bypasses React's virtual DOM | Use state + JSX |
| `innerHTML = template` | XSS risk, no reconciliation | Map data to JSX elements |
| `element.style.display` | React doesn't know about it | Conditional rendering |
| `addEventListener` in useEffect on DOM nodes | Memory leaks, double binds | JSX event props |
| `setTimeout` without cleanup | Runs after unmount | `useEffect` with return |
| Global variables for state | No re-render on change | `useState` or context |
| `window.location.href` for navigation | Full page reload | React Router `navigate()` |
| Fetching in component body | Runs every render | `useEffect` or event handler |
| Copying props into state | Stale data, double source of truth | Use props directly |
| `useEffect` to sync two states | Unnecessary render cycle | Compute during render with `useMemo` |

---

## 14. Shared Component Inventory (Extract These)

These components appear across multiple pages and should be built once:

| Component | Used By | Description |
|---|---|---|
| `<Layout>` | All 24 pages | Sidebar nav + main content area |
| `<DateRangeFilter>` | ~15 pages | From/to date inputs with presets |
| `<GroupFilter>` | ~10 pages | MT5 group dropdown/search |
| `<SortableTable>` | ~20 pages | Table with column sort, number formatting |
| `<PnlCell>` | ~12 pages | Green/red number with formatting |
| `<LoadingSpinner>` | All pages | Loading indicator |
| `<ErrorBanner>` | All pages | Error display with retry |
| `<StatCard>` | ~8 pages | Summary stat card (label + value) |
| `<TabPanel>` | ~6 pages | Tab navigation + panel switching |
| `<ExportButton>` | ~5 pages | CSV/Excel export |

---

## 15. Migration Order

Convert pages in this order (dependencies first):

1. **Shared components** — Layout, SortableTable, DateRangeFilter, hooks
2. **Simple pages** (2) — weather-forecast, health-check (learn the pattern)
3. **Medium pages** (10) — CRUD pages, simple data views
4. **Complex pages** (12) — SignalR pages, deal matching, client profiling last

---

## Quick Checklist Per Page

When converting any page, verify every item:

- [ ] No `document.*` calls anywhere
- [ ] No `innerHTML` or `textContent` assignments
- [ ] No `addEventListener` / `removeEventListener`
- [ ] No `setInterval` / `setTimeout` without cleanup
- [ ] No `element.style.*` manipulation
- [ ] No `element.classList.*` manipulation
- [ ] No global `let`/`var` for state — use `useState`
- [ ] No `window.location` — use React Router
- [ ] All fetches use shared hook with loading/error states
- [ ] All tables use `<SortableTable>` or equivalent
- [ ] All formatting uses shared utility functions
- [ ] SignalR connection uses shared hook with cleanup
- [ ] localStorage uses `useLocalStorage` hook
- [ ] Component is split if over ~200 lines
