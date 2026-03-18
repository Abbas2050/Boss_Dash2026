import { useMemo, useState } from "react";

type SortDirection = "asc" | "desc";

export type SortableTableColumn<T> = {
  key: string;
  label: string;
  headerClassName?: string;
  cellClassName?: string;
  sortValue?: (row: T) => string | number;
  searchValue?: (row: T) => string;
  render: (row: T) => React.ReactNode;
};

type SortableTableProps<T> = {
  rows: T[];
  columns: SortableTableColumn<T>[];
  tableClassName?: string;
  emptyText?: string;
  exportFilePrefix?: string;
  rowClassName?: (row: T, index: number) => string;
};

const csvEscape = (value: string) => {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
};

const defaultSearchValue = <T,>(row: T, columns: SortableTableColumn<T>[]) => {
  return columns
    .map((col) => {
      if (col.searchValue) return col.searchValue(row);
      if (col.sortValue) return String(col.sortValue(row));
      return "";
    })
    .join(" ")
    .toLowerCase();
};

export function SortableTable<T>({
  rows,
  columns,
  tableClassName = "min-w-full text-xs",
  emptyText = "No data available.",
  exportFilePrefix = "table",
  rowClassName,
}: SortableTableProps<T>) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<string>("");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => defaultSearchValue(row, columns).includes(q));
  }, [rows, columns, query]);

  const sortedRows = useMemo(() => {
    if (!sortKey) return filteredRows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col || !col.sortValue) return filteredRows;

    return [...filteredRows].sort((a, b) => {
      const av = col.sortValue ? col.sortValue(a) : "";
      const bv = col.sortValue ? col.sortValue(b) : "";
      let cmp = 0;
      if (typeof av === "number" && typeof bv === "number") {
        cmp = av - bv;
      } else {
        cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });
  }, [filteredRows, columns, sortKey, sortDirection]);

  const exportCsv = () => {
    if (!sortedRows.length) return;
    const header = columns.map((col) => csvEscape(col.label)).join(",");
    const body = sortedRows
      .map((row) =>
        columns
          .map((col) => {
            const raw = col.searchValue ? col.searchValue(row) : col.sortValue ? String(col.sortValue(row)) : "";
            return csvEscape(String(raw || ""));
          })
          .join(","),
      )
      .join("\n");
    const csv = `${header}\n${body}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
    link.href = URL.createObjectURL(blob);
    link.download = `${exportFilePrefix}-${stamp}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all columns..."
          className="w-full sm:w-auto rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-100"
        />
        <button
          type="button"
          onClick={() => {
            setQuery("");
            setSortKey("");
            setSortDirection("asc");
          }}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!sortedRows.length}
          className="rounded-md border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-emerald-300"
        >
          Export CSV
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className={tableClassName}>
          <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => {
                    if (!col.sortValue) return;
                    if (sortKey === col.key) {
                      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
                    } else {
                      setSortKey(col.key);
                      setSortDirection("asc");
                    }
                  }}
                  className={`px-3 py-2 font-semibold uppercase tracking-wide ${col.sortValue ? "cursor-pointer select-none" : ""} ${col.headerClassName || "text-left"}`}
                >
                  {col.label}
                  {sortKey === col.key ? (sortDirection === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, index) => (
              <tr key={index} className={rowClassName ? rowClassName(row, index) : "bg-slate-50 dark:bg-slate-950/30"}>
                {columns.map((col) => (
                  <td key={col.key} className={`border-t border-slate-800 px-3 py-2 ${col.cellClassName || "text-left"}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
            {sortedRows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-center text-xs text-slate-500" colSpan={columns.length}>
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
