import { useEffect, useMemo, useRef, useState } from "react";

type SortDirection = "asc" | "desc";

export type SortableTableColumn<T> = {
  key: string;
  label: string;
  headerClassName?: string;
  cellClassName?: string;
  sortValue?: (row: T) => string | number;
  searchValue?: (row: T) => string;
  render: (row: T) => React.ReactNode;
  hideable?: boolean;
  defaultVisible?: boolean;
};

type SortableTableProps<T> = {
  rows: T[];
  columns: SortableTableColumn<T>[];
  tableId?: string;
  enableColumnVisibility?: boolean;
  tableClassName?: string;
  emptyText?: string;
  exportFilePrefix?: string;
  rowClassName?: (row: T, index: number) => string;
};

const COLUMN_VISIBILITY_STORAGE_PREFIX = "bossdash:table-columns:";
const COLUMN_ORDER_STORAGE_PREFIX = "bossdash:table-column-order:";

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

const getDefaultVisibleColumnKeys = <T,>(columns: SortableTableColumn<T>[]) =>
  columns.filter((col) => col.hideable === false || col.defaultVisible !== false).map((col) => col.key);

const reconcileVisibleColumnKeys = <T,>(columns: SortableTableColumn<T>[], existingKeys?: string[] | null) => {
  const availableKeys = new Set(columns.map((col) => col.key));
  const nextKeys = Array.isArray(existingKeys) ? existingKeys.filter((key) => availableKeys.has(key)) : [];

  columns.forEach((col) => {
    const shouldForceVisible = col.hideable === false;
    const isNewColumn = !Array.isArray(existingKeys) || !existingKeys.includes(col.key);
    const shouldDefaultVisible = col.defaultVisible !== false;
    if ((shouldForceVisible || (isNewColumn && shouldDefaultVisible)) && !nextKeys.includes(col.key)) {
      nextKeys.push(col.key);
    }
  });

  if (!nextKeys.length && columns.length) {
    return getDefaultVisibleColumnKeys(columns).length ? getDefaultVisibleColumnKeys(columns) : [columns[0].key];
  }

  return nextKeys;
};

const reconcileColumnOrderKeys = <T,>(columns: SortableTableColumn<T>[], existingKeys?: string[] | null) => {
  const availableKeys = new Set(columns.map((col) => col.key));
  const nextKeys = Array.isArray(existingKeys) ? existingKeys.filter((key) => availableKeys.has(key)) : [];

  columns.forEach((col) => {
    if (!nextKeys.includes(col.key)) {
      nextKeys.push(col.key);
    }
  });

  return nextKeys;
};

export function SortableTable<T>({
  rows,
  columns,
  tableId,
  enableColumnVisibility = false,
  tableClassName = "min-w-full text-xs",
  emptyText = "No data available.",
  exportFilePrefix = "table",
  rowClassName,
}: SortableTableProps<T>) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<string>("");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [isColumnMenuOpen, setIsColumnMenuOpen] = useState(false);
  const [draggingColumnKey, setDraggingColumnKey] = useState<string | null>(null);
  const columnMenuRef = useRef<HTMLDivElement | null>(null);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<string[]>(() => {
    const fallback = reconcileVisibleColumnKeys(columns, null);
    if (!enableColumnVisibility || !tableId || typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem(`${COLUMN_VISIBILITY_STORAGE_PREFIX}${tableId}`);
      if (!raw) return fallback;
      return reconcileVisibleColumnKeys(columns, JSON.parse(raw) as string[]);
    } catch {
      return fallback;
    }
  });
  const [columnOrderKeys, setColumnOrderKeys] = useState<string[]>(() => {
    const fallback = reconcileColumnOrderKeys(columns, null);
    if (!enableColumnVisibility || !tableId || typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem(`${COLUMN_ORDER_STORAGE_PREFIX}${tableId}`);
      if (!raw) return fallback;
      return reconcileColumnOrderKeys(columns, JSON.parse(raw) as string[]);
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    setVisibleColumnKeys((current) => reconcileVisibleColumnKeys(columns, current));
  }, [columns]);

  useEffect(() => {
    setColumnOrderKeys((current) => reconcileColumnOrderKeys(columns, current));
  }, [columns]);

  useEffect(() => {
    if (!enableColumnVisibility || !tableId || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(`${COLUMN_VISIBILITY_STORAGE_PREFIX}${tableId}`, JSON.stringify(visibleColumnKeys));
    } catch {
      // Ignore storage failures.
    }
  }, [enableColumnVisibility, tableId, visibleColumnKeys]);

  useEffect(() => {
    if (!enableColumnVisibility || !tableId || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(`${COLUMN_ORDER_STORAGE_PREFIX}${tableId}`, JSON.stringify(columnOrderKeys));
    } catch {
      // Ignore storage failures.
    }
  }, [columnOrderKeys, enableColumnVisibility, tableId]);

  useEffect(() => {
    if (!isColumnMenuOpen) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (columnMenuRef.current?.contains(target)) return;
      setIsColumnMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [isColumnMenuOpen]);

  const orderedColumns = useMemo(() => {
    if (!enableColumnVisibility) return columns;
    const columnMap = new Map(columns.map((col) => [col.key, col]));
    return columnOrderKeys.map((key) => columnMap.get(key)).filter((col): col is SortableTableColumn<T> => Boolean(col));
  }, [columnOrderKeys, columns, enableColumnVisibility]);

  const visibleColumns = useMemo(() => {
    if (!enableColumnVisibility) return orderedColumns;
    const visibleKeySet = new Set(visibleColumnKeys);
    return orderedColumns.filter((col) => visibleKeySet.has(col.key));
  }, [orderedColumns, enableColumnVisibility, visibleColumnKeys]);

  useEffect(() => {
    if (sortKey && !visibleColumns.some((col) => col.key === sortKey)) {
      setSortKey("");
      setSortDirection("asc");
    }
  }, [sortKey, visibleColumns]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => defaultSearchValue(row, visibleColumns).includes(q));
  }, [rows, visibleColumns, query]);

  const sortedRows = useMemo(() => {
    if (!sortKey) return filteredRows;
    const col = visibleColumns.find((c) => c.key === sortKey);
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
  }, [filteredRows, visibleColumns, sortKey, sortDirection]);

  const hideableColumns = useMemo(() => orderedColumns.filter((col) => col.hideable !== false), [orderedColumns]);

  const toggleColumnVisibility = (key: string) => {
    setVisibleColumnKeys((current) => {
      const currentSet = new Set(current);
      if (currentSet.has(key)) {
        const next = current.filter((value) => value !== key);
        return next.length ? next : current;
      }
      return reconcileVisibleColumnKeys(columns, [...current, key]);
    });
  };

  const resetVisibleColumns = () => {
    setVisibleColumnKeys(reconcileVisibleColumnKeys(columns, null));
  };

  const showAllColumns = () => {
    setVisibleColumnKeys(reconcileVisibleColumnKeys(columns, columns.map((col) => col.key)));
  };

  const clearOptionalColumns = () => {
    setVisibleColumnKeys(reconcileVisibleColumnKeys(columns, columns.filter((col) => col.hideable === false).map((col) => col.key)));
  };

  const resetColumnOrder = () => {
    setColumnOrderKeys(reconcileColumnOrderKeys(columns, null));
  };

  const moveColumn = (draggedKey: string, targetKey: string) => {
    if (!draggedKey || draggedKey === targetKey) return;
    setColumnOrderKeys((current) => {
      const next = [...current];
      const fromIndex = next.indexOf(draggedKey);
      const toIndex = next.indexOf(targetKey);
      if (fromIndex === -1 || toIndex === -1) return current;
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const exportCsv = () => {
    if (!sortedRows.length) return;
    const header = visibleColumns.map((col) => csvEscape(col.label)).join(",");
    const body = sortedRows
      .map((row) =>
        visibleColumns
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
          placeholder="Search visible columns..."
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
        {enableColumnVisibility && (
          <div className="relative" ref={columnMenuRef}>
            <button
              type="button"
              onClick={() => setIsColumnMenuOpen((value) => !value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200"
            >
              Columns ({visibleColumns.length}/{columns.length})
            </button>
            {isColumnMenuOpen && (
              <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-950">
                <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-200 px-1 pb-2 text-[11px] uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <span>Visible Columns</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={showAllColumns}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 hover:bg-cyan-50 dark:text-cyan-300 dark:hover:bg-cyan-500/10"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={clearOptionalColumns}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 hover:bg-cyan-50 dark:text-cyan-300 dark:hover:bg-cyan-500/10"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        resetVisibleColumns();
                        resetColumnOrder();
                      }}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 hover:bg-cyan-50 dark:text-cyan-300 dark:hover:bg-cyan-500/10"
                    >
                      Reset
                    </button>
                  </div>
                </div>
                <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                  {orderedColumns.map((col) => {
                    const checked = visibleColumnKeys.includes(col.key);
                    const locked = col.hideable === false;
                    const isLastVisibleHideable = checked && hideableColumns.filter((item) => visibleColumnKeys.includes(item.key)).length <= 1;
                    return (
                      <div
                        key={col.key}
                        draggable
                        onDragStart={() => setDraggingColumnKey(col.key)}
                        onDragOver={(event) => {
                          event.preventDefault();
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (draggingColumnKey) {
                            moveColumn(draggingColumnKey, col.key);
                          }
                          setDraggingColumnKey(null);
                        }}
                        onDragEnd={() => setDraggingColumnKey(null)}
                        className={`flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs ${locked ? "bg-slate-50 text-slate-500 dark:bg-slate-900/70 dark:text-slate-400" : "hover:bg-slate-50 dark:hover:bg-slate-900/60"} ${draggingColumnKey === col.key ? "opacity-50" : ""}`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="cursor-grab text-slate-400 dark:text-slate-500" title="Drag to reorder">
                            ::
                          </span>
                          <label className={`flex min-w-0 items-center justify-between gap-3 ${locked ? "" : "cursor-pointer"}`}>
                            <span className="truncate">{col.label}</span>
                          </label>
                        </div>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={locked || isLastVisibleHideable}
                          onChange={() => toggleColumnVisibility(col.key)}
                          className="h-3.5 w-3.5 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-900"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className={tableClassName}>
          <thead className="bg-slate-100 text-slate-700 dark:bg-slate-900/90 dark:text-slate-300">
            <tr>
              {visibleColumns.map((col) => (
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
                {visibleColumns.map((col) => (
                  <td key={col.key} className={`border-t border-slate-800 px-3 py-2 ${col.cellClassName || "text-left"}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
            {sortedRows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-center text-xs text-slate-500" colSpan={visibleColumns.length || 1}>
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
