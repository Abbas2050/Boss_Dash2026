export type ContractSizeMap = Record<string, number>;

// TODO: Replace these defaults with authoritative sizes from your broker/MT5 symbol specs.
// You can also load/merge sizes from an API or a JSON file.
export const DEFAULT_CONTRACT_SIZES: ContractSizeMap = {
  // Common FX
  EURUSD: 100000,
  GBPUSD: 100000,
  USDJPY: 100000,
  USDCHF: 100000,
  AUDUSD: 100000,
  USDCAD: 100000,
  NZDUSD: 100000,
  EURGBP: 100000,
  EURJPY: 100000,
  GBPJPY: 100000,

  // Metals (typical values, verify with your broker)
  XAUUSD: 100,
  XAGUSD: 5000,
};

export function getContractSize(symbol: string, sizes: ContractSizeMap = DEFAULT_CONTRACT_SIZES): number {
  if (!symbol) return 100000;
  const normalized = symbol.toUpperCase().trim();
  return sizes[normalized] ?? 100000; // fallback to FX standard lot size
}
