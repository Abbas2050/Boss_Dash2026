/**
 * Per-symbol drilldown for the Deal Match "Client LP Allocation Detail" table.
 *
 * Ported from `temporay_for_reference_pages/deal-matching 9.html`, which is
 * newer than the React tab (see docs/dealing-reporting.md §8). Each (client, LP)
 * parent row can expand into the per-symbol rows the backend already ships in
 * `DealMatch/Run -> clientLpSymbolCommissions`, so no extra request is made:
 * the payload is filtered client-side.
 *
 * It lives outside DealMatchingTab.tsx because that file is ~1,700 lines
 * already, and because everything here -- matching, ordering, the totals guard
 * -- is pure and worth testing without mounting a React tree.
 */

import type { SortableTableColumn } from "@/components/ui/SortableTable";
import {
  classifySymbolCommSource,
  commSourceTag,
  rollUpCommSource,
  type ClientLpSymbolCommission,
  type CommSource,
} from "./dealMatchCommSource";

export type LpDetailRow = Record<string, any>;

/** A row as rendered by the detail table: either a (client, LP) parent or one
 *  of its per-symbol children. */
export type LpDetailDisplayRow = LpDetailRow & {
  /** True on a per-symbol child. Every consumer that sums must skip these. */
  __isDetail?: boolean;
  /** The child's symbol -- also its identity within the parent. */
  __symKey?: string;
  /** Back-reference to the parent, so a child can borrow the parent's sort
   *  position instead of being sorted away from it. */
  __parent?: LpDetailDisplayRow;
  /** Whether this parent has per-symbol children to expand into. Drives the
   *  chevron: a parent with none must not offer one. */
  __hasChildren?: boolean;
  /** Whether this parent is currently expanded. Carried on the row so the
   *  column definitions stay static -- they would otherwise have to be rebuilt
   *  on every toggle just to read the expansion set. */
  __expanded?: boolean;
  /** The key this parent is expanded under. Stamped here so a click handler
   *  never has to re-derive it (and cannot derive a different one). */
  __expansionKey?: string;
  lpCommissionSource?: CommSource | "";
};

const numeric = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const text = (value: unknown): string => (value == null ? "" : String(value).trim());

/** The login a parent row belongs to. ClientRevenueDetail rows carry it, but the
 *  table is always opened for one known client, so the caller's login is a safe
 *  fallback when the payload omits the field. */
function parentLogin(parent: LpDetailRow, fallbackLogin?: string | number): string {
  const own = text(parent?.login);
  return own || text(fallbackLogin);
}

/**
 * Identity of a parent row for expansion purposes. Deliberately (login, lpsid)
 * and not the object itself: the set of expanded keys then outlives any given
 * fetch, which is what keeps a row open across a data refresh.
 */
export function lpDetailExpansionKey(parent: LpDetailRow, fallbackLogin?: string | number): string {
  return `${parentLogin(parent, fallbackLogin)}-${text(parent?.lpsid)}`;
}

/**
 * The per-symbol children of one parent row.
 *
 * Matched on login AND lpsid AND lpName. The reference page spells the
 * two-key LP match out ("Match on BOTH lpsid AND lpName"): an lpsid is reused
 * across LP names in the payload, so matching on the sid alone pulls another
 * LP's symbols under this parent and inflates the drilldown.
 */
export function symbolChildrenFor(
  parent: LpDetailRow,
  symbolRows: ClientLpSymbolCommission[],
  fallbackLogin?: string | number,
): ClientLpSymbolCommission[] {
  const login = parentLogin(parent, fallbackLogin);
  if (!login) return [];
  const lpsid = text(parent?.lpsid);
  const lpName = text(parent?.lpName);

  return (symbolRows || [])
    .filter((r) => text(r?.login) === login && text(r?.lpsid) === lpsid && text(r?.lpName) === lpName)
    // Stable per-symbol order (client lots desc, then alphabetical) so an
    // expansion looks the same on every render and the parent's own position in
    // the table is untouched.
    .sort(
      (a, b) => numeric(b.clientLots) - numeric(a.clientLots) || text(a.symbol).localeCompare(text(b.symbol)),
    );
}

/** Does this parent have anything to expand into? */
export function hasSymbolChildren(
  parent: LpDetailRow,
  symbolRows: ClientLpSymbolCommission[],
  fallbackLogin?: string | number,
): boolean {
  return symbolChildrenFor(parent, symbolRows, fallbackLogin).length > 0;
}

/** Detail source rows use shortened field names (clientLots, netLpCommUsd);
 *  the shared columns reference the parent's longer ones. Aliasing here lets one
 *  set of columns render both kinds of row. */
function toDisplayChild(
  parent: LpDetailDisplayRow,
  child: ClientLpSymbolCommission,
  login: string,
): LpDetailDisplayRow {
  return {
    __isDetail: true,
    __symKey: text(child.symbol),
    __parent: parent,
    login,
    lpsid: text(parent.lpsid),
    lpName: "",
    tradeCount: child.tradeCount,
    symbols: child.symbol,
    clientLotsPlaced: child.clientLots,
    clientMillionsUsd: child.clientMillionsUsd,
    // No per-symbol split exists for these two, so they stay blank rather than
    // showing a zero that would read as "nothing was sent to the LP".
    lpLotsSent: null,
    allocationPct: null,
    markupRevenueUsd: child.markupRevenueUsd,
    mt5MarkupUsd: child.mt5MarkupUsd,
    centroidMarkupUsd: child.centroidMarkupUsd,
    clientCommissionUsd: child.clientCommissionUsd,
    grossRevenueUsd: child.grossRevenueUsd,
    lpCommissionUsd: child.netLpCommUsd,
    lpCommissionSource: classifySymbolCommSource(child),
  };
}

/**
 * The rows to render: every parent in its original order, each followed by its
 * per-symbol children when expanded. Parents are annotated with `__hasChildren`
 * and their rolled-up `lpCommissionSource`.
 *
 * Parents are never reordered and never mutated -- a copy is annotated -- so
 * nothing about the existing table's content or ordering changes when nothing
 * is expanded.
 */
export function buildClientLpDetailRows(
  parents: LpDetailRow[],
  symbolRows: ClientLpSymbolCommission[],
  expandedKeys: ReadonlySet<string>,
  fallbackLogin?: string | number,
): LpDetailDisplayRow[] {
  const out: LpDetailDisplayRow[] = [];

  for (const raw of parents || []) {
    const login = parentLogin(raw, fallbackLogin);
    const children = symbolChildrenFor(raw, symbolRows, fallbackLogin);
    const key = lpDetailExpansionKey(raw, fallbackLogin);
    const expanded = children.length > 0 && expandedKeys.has(key);
    const parent: LpDetailDisplayRow = {
      ...raw,
      __isDetail: false,
      __hasChildren: children.length > 0,
      __expanded: expanded,
      __expansionKey: key,
      // The roll-up of the children's branches (several branches on one parent
      // is "Mixed"); with no children to roll up, the backend's own tag if it
      // sent one, and otherwise nothing -- an unlabelled row is honest, an
      // invented label is not.
      lpCommissionSource: children.length
        ? rollUpCommSource(children.map((c) => classifySymbolCommSource(c)))
        : commSourceTag(raw.lpCommissionSource),
    };
    out.push(parent);

    if (!expanded) continue;
    for (const child of children) out.push(toDisplayChild(parent, child, login));
  }

  return out;
}

export function isDetailRow(row: LpDetailDisplayRow | null | undefined): boolean {
  return Boolean(row && row.__isDetail);
}

/** Parents only. Every aggregate over the display rows goes through this. */
export function parentRowsOnly(rows: LpDetailDisplayRow[]): LpDetailDisplayRow[] {
  return (rows || []).filter((row) => !isDetailRow(row));
}

/**
 * The pinned-TOTAL figures for the detail table.
 *
 * Detail rows are excluded: a parent already carries the whole (client, LP)
 * total, and its children re-state the SAME money apportioned across symbols.
 * Summing both would make the TOTAL grow simply because someone expanded a row.
 */
export function computeClientLpDetailTotals(rows: LpDetailDisplayRow[]) {
  const parents = parentRowsOnly(rows);
  const sum = (field: string) => parents.reduce((acc, r) => acc + numeric(r[field]), 0);
  const grossRevenueUsd = sum("grossRevenueUsd");
  const lpCommissionUsd = sum("lpCommissionUsd");
  return {
    tradeCount: sum("tradeCount"),
    clientLotsPlaced: sum("clientLotsPlaced"),
    clientMillionsUsd: sum("clientMillionsUsd"),
    lpLotsSent: sum("lpLotsSent"),
    markupRevenueUsd: sum("markupRevenueUsd"),
    clientCommissionUsd: sum("clientCommissionUsd"),
    grossRevenueUsd,
    lpCommissionUsd,
    // Unchanged from before the drilldown existed: Gross less the
    // coverage-attributed LP Commission, computed client-side.
    netRevenueUsd: grossRevenueUsd - lpCommissionUsd,
  };
}

/**
 * Make every column sort a child by its PARENT's value.
 *
 * SortableTable sorts the flat row list, and JS sort is stable, so equal keys
 * keep insertion order: a child that reports its parent's sort value lands
 * immediately after that parent whichever column is sorted, and the parents'
 * own order is exactly what it would have been with no expansion at all. The
 * same inheritance is applied to the search text so a child is never left
 * stranded by a filter that dropped its parent.
 */
export function withDetailRowsFollowingParents<T extends LpDetailDisplayRow>(
  columns: SortableTableColumn<T>[],
): SortableTableColumn<T>[] {
  return columns.map((col) => ({
    ...col,
    sortValue: col.sortValue
      ? (row: T) => col.sortValue!((isDetailRow(row) && row.__parent ? row.__parent : row) as T)
      : undefined,
    searchValue: col.searchValue
      ? (row: T) => col.searchValue!((isDetailRow(row) && row.__parent ? row.__parent : row) as T)
      : undefined,
  }));
}
