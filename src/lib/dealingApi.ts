export interface GroupSummaryResponse {
  fromTimestamp: number;
  fromDate: string;
  toTimestamp: number;
  toDate: string;
  queryType: string;
  queryValue: string;
  currentBalance: number;
  currentEquity: number;
  currentCredit: number;
  totalDeposits: number;
  totalWithdrawals: number;
  netDeposits: number;
  totalCreditsIn: number;
  totalCreditsOut: number;
  netCredits: number;
  tradingProfit: number;
  totalCommissions: number;
  totalSwaps: number;
  totalFees: number;
  netLotsBuy: number;
  netLotsSell: number;
  netLots: number;
  dealCount: number;
  depositCount: number;
  withdrawalCount: number;
  creditCount: number;
  tradeCount: number;
}

export interface GroupPosition {
  login: number;
  symbol: string;
  action: number;
  lots: number;
  volume: number;
  volumeExt: number;
}

export interface GroupDeal {
  deal: number;
  login: number;
  action: number;
  symbol: string;
  price: number;
  contractSize: number;
  lots: number;
  volume: number;
  volumeExt: number;
  value: number;
  profit: number;
  commission: number;
  fee: number;
  storage: number;
}

const BACKEND_BASE_URL = String((import.meta as any).env?.VITE_BACKEND_BASE_URL || 'https://api.skylinkscapital.com').replace(/\/+$/, '');

const toNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatDateAsDDMMYYYY = (date: Date) => {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = String(date.getUTCFullYear());
  return `${day}-${month}-${year}`;
};

export async function getSummaryByGroup(params: {
  group: string;
  from: Date;
  to: Date;
}): Promise<GroupSummaryResponse> {
  const endpoint = `${BACKEND_BASE_URL}/Report/GetSummaryByGroup`;

  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set('group', params.group);
  url.searchParams.set('from', formatDateAsDDMMYYYY(params.from));
  url.searchParams.set('to', formatDateAsDDMMYYYY(params.to));

  const response = await fetch(url.toString(), {
    headers: {
      accept: 'text/plain',
    },
  });

  if (!response.ok) {
    throw new Error(`GetSummaryByGroup failed with status ${response.status}`);
  }

  const json = (await response.json()) as Partial<GroupSummaryResponse>;

  return {
    fromTimestamp: toNumber(json.fromTimestamp),
    fromDate: String(json.fromDate ?? ''),
    toTimestamp: toNumber(json.toTimestamp),
    toDate: String(json.toDate ?? ''),
    queryType: String(json.queryType ?? ''),
    queryValue: String(json.queryValue ?? ''),
    currentBalance: toNumber(json.currentBalance),
    currentEquity: toNumber(json.currentEquity),
    currentCredit: toNumber(json.currentCredit),
    totalDeposits: toNumber(json.totalDeposits),
    totalWithdrawals: toNumber(json.totalWithdrawals),
    netDeposits: toNumber(json.netDeposits),
    totalCreditsIn: toNumber(json.totalCreditsIn),
    totalCreditsOut: toNumber(json.totalCreditsOut),
    netCredits: toNumber(json.netCredits),
    tradingProfit: toNumber(json.tradingProfit),
    totalCommissions: toNumber(json.totalCommissions),
    totalSwaps: toNumber(json.totalSwaps),
    totalFees: toNumber(json.totalFees),
    netLotsBuy: toNumber(json.netLotsBuy),
    netLotsSell: toNumber(json.netLotsSell),
    netLots: toNumber(json.netLots),
    dealCount: toNumber(json.dealCount),
    depositCount: toNumber(json.depositCount),
    withdrawalCount: toNumber(json.withdrawalCount),
    creditCount: toNumber(json.creditCount),
    tradeCount: toNumber(json.tradeCount),
  };
}

export async function getPositionsByGroup(params: { group: string }): Promise<GroupPosition[]> {
  const endpoint = `${BACKEND_BASE_URL}/Position/GetPositionsByGroup`;

  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set('group', params.group);

  const response = await fetch(url.toString(), {
    headers: {
      accept: 'text/plain',
    },
  });

  if (!response.ok) {
    throw new Error(`GetPositionsByGroup failed with status ${response.status}`);
  }

  const json = (await response.json()) as Array<Partial<GroupPosition>>;

  return json.map((item) => ({
    login: toNumber(item.login),
    symbol: String(item.symbol ?? ''),
    action: toNumber(item.action),
    lots: toNumber(item.lots),
    volume: toNumber(item.volume),
    volumeExt: toNumber(item.volumeExt),
  }));
}

export async function getDealsByGroup(params: {
  group: string;
  from: Date;
  to: Date;
}): Promise<GroupDeal[]> {
  const endpoint = `${BACKEND_BASE_URL}/Deal/GetDealsByGroup`;

  const url = new URL(endpoint, window.location.origin);
  url.searchParams.set('group', params.group);
  url.searchParams.set('from', formatDateAsDDMMYYYY(params.from));
  url.searchParams.set('to', formatDateAsDDMMYYYY(params.to));

  const response = await fetch(url.toString(), {
    headers: {
      accept: 'text/plain',
    },
  });

  if (!response.ok) {
    throw new Error(`GetDealsByGroup failed with status ${response.status}`);
  }

  const json = (await response.json()) as Array<Partial<GroupDeal>>;

  return json.map((item) => ({
    deal: toNumber(item.deal),
    login: toNumber(item.login),
    action: toNumber(item.action),
    symbol: String(item.symbol ?? ''),
    price: toNumber(item.price),
    contractSize: toNumber(item.contractSize),
    lots: toNumber(item.lots),
    volume: toNumber(item.volume),
    volumeExt: toNumber(item.volumeExt),
    value: toNumber(item.value),
    profit: toNumber(item.profit),
    commission: toNumber(item.commission),
    fee: toNumber(item.fee),
    storage: toNumber(item.storage),
  }));
}
