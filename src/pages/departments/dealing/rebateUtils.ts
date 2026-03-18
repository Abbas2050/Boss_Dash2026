export const REBATE_RULES_SAMPLE_CSV = `symbol,rate_per_lot
XAUUSD,2.00
EURUSD,1.00
GBPUSD,1.00
US30,0.50
*,0.00
`;

export const normalizeRebateSymbol = (symbol: string) => {
  const upper = String(symbol || "").trim().toUpperCase();
  if (!upper) return "";
  const dot = upper.indexOf(".");
  return dot === -1 ? upper : upper.slice(0, dot);
};

const wildcardToRegex = (pattern: string) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
};

export const getRateForSymbol = (
  symbol: string,
  rules: Array<{ symbolPattern: string; ratePerLot: number }>,
  defaultRatePerLot: number,
) => {
  const normalized = normalizeRebateSymbol(symbol);
  for (const rule of rules) {
    const target = normalizeRebateSymbol(rule.symbolPattern);
    if (!target) continue;
    if (target.includes("*")) {
      if (wildcardToRegex(target).test(normalized)) return rule.ratePerLot;
      continue;
    }
    if (target === normalized) return rule.ratePerLot;
  }
  return Number.isFinite(defaultRatePerLot) && defaultRatePerLot > 0 ? defaultRatePerLot : 0;
};
