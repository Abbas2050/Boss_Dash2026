// MT5 API Types and Interfaces

export interface MT5User {
  Login: number;
  Name: string;
  Email: string;
  Group: string;
  Balance: number;
  Credit: number;
  Equity?: number;
  Margin?: number;
  MarginFree?: number;
  MarginLevel?: number;
  Country?: string;
  City?: string;
  State?: string;
  ZipCode?: string;
  Address?: string;
  Phone?: string;
  Comment?: string;
  Status?: string;
  Registration?: number;
  LastAccess?: number;
  LastPassChange?: number;
  Agent?: number;
  Leverage?: number;
  Currency?: string;
}

export interface MT5Account {
  Login: number;
  Balance: number;
  Credit: number;
  Equity: number;
  Margin: number;
  MarginFree: number;
  MarginLevel: number;
  Group: string;
  Currency: string;
  Leverage: number;
}

export interface MT5AccountState {
  Login: number;
  CurrencyDigits?: number;
  Balance?: number;
  Credit?: number;
  Equity?: number;
  Profit?: number;
  Storage?: number;
  Commission?: number;
  Floating?: number;
  Margin?: number;
  MarginFree?: number;
  MarginLevel?: number;
  MarginLeverage?: number;
}

export interface MT5Trade {
  Deal: number;
  ExternalID?: string;
  Login: number;
  Dealer?: number;
  Order: number;
  Action: number;
  Entry: number;
  Reason?: number;
  Digits?: number;
  DigitsCurrency?: number;
  ContractSize?: number;
  Time: number;
  TimeMsc?: number;
  Symbol: string;
  Price: number;
  Volume: number;
  VolumeExt?: number;
  Profit: number;
  Value?: number;
  Storage?: number;
  Commission?: number;
  RateProfit?: number;
  RateMargin?: number;
  ExpertID?: number;
  PositionID?: number;
  Comment?: string;
}

export interface MT5Position {
  Login: number;
  Symbol: string;
  Action: number;
  Digits?: number;
  DigitsCurrency?: number;
  ContractSize?: number;
  Position: number;
  ExternalID?: string;
  TimeCreate: number;
  TimeUpdate: number;
  TimeCreateMsc?: number;
  TimeUpdateMsc?: number;
  PriceOpen: number;
  PriceCurrent: number;
  PriceSL?: number;
  PriceTP?: number;
  Volume: number;
  VolumeExt?: number;
  Profit: number;
  Storage?: number;
  RateProfit?: number;
  RateMargin?: number;
  ExpertID?: number;
  ExpertPositionID?: number;
  Comment?: string;
  Dealer?: number;
  ActivationMode?: number;
  ActivationTime?: number;
  ActivationPrice?: number;
  ActivationFlags?: number;
  ModificationFlags?: number;
  Reason?: number;
}

export interface MT5ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface MT5UsersRequest {
  logins: number[];
}

export interface MT5TradesRequest {
  login: number;
  from?: number; // Unix timestamp
  to?: number;   // Unix timestamp
}

export interface MT5DailyReport {
  Timestamp?: number | string;
  DatetimePrev?: number;
  Login: number;
  Name?: string;
  Group?: string;
  Currency?: string;
  CurrencyDigits?: number;
  Balance?: number;
  Credit?: number;
  Margin?: number;
  MarginFree?: number;
  MarginLevel?: number;
  Profit?: number;
  ProfitEquity?: number;
  PositionAdd?: MT5Position[];
}
