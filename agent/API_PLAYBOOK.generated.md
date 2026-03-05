# API Playbook (Auto-Generated)

- Source: http://50.28.86.170/swagger/v1/swagger.json
- Title: SLCDashboard
- Version: 1.0
- Endpoints: 65
- Fetched: 2026-02-24T09:01:28.552634Z

## Account

### `GET /Account/GetAccountByLogin`
- Parameters:
  - `login` (query, integer, optional)
- Responses: 200

### `GET /Account/GetAccountsByGroup`
- Parameters:
  - `path` (query, string, optional)
- Responses: 200

### `GET /Account/GetAllAccounts`
- Responses: 200

### `GET /Account/GetUserInfo`
- Parameters:
  - `login` (query, integer, optional)
- Responses: 200

### `GET /Account/GetUserInfoBatch`
- Parameters:
  - `logins` (query, array, optional)
- Responses: 200

## Coverage

### `GET /Coverage/dashboard`
- Responses: 200

### `GET /Coverage/dashboard/{baseSymbol}`
- Parameters:
  - `baseSymbol` (path, string, required)
- Responses: 200

### `GET /Coverage/lp/{lpName}/positions`
- Parameters:
  - `lpName` (path, string, required)
- Responses: 200

### `GET /Coverage/position-match-table`
- Responses: 200

### `GET /Coverage/summary`
- Responses: 200

## Deal

### `GET /Deal/GetDealsByGroup`
- Parameters:
  - `group` (query, string, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
- Responses: 200

### `GET /Deal/GetDealsByGroupSymbol`
- Parameters:
  - `group` (query, string, optional)
  - `symbol` (query, string, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
- Responses: 200

### `GET /Deal/GetDealsByLogin`
- Parameters:
  - `login` (query, integer, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
- Responses: 200

### `GET /Deal/GetDealsByLogins`
- Parameters:
  - `from` (query, string, optional)
  - `to` (query, string, optional)
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

### `GET /Deal/GetDealsByLoginsSymbol`
- Parameters:
  - `symbol` (query, string, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

### `GET /Deal/GetDealsByTickets`
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

### `GET /Deal/GetTransactions`
- Parameters:
  - `login` (query, integer, optional)
  - `group` (query, string, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
  - `action` (query, integer, optional)
- Responses: 200

## DealMatch

### `GET /DealMatch/CentroidOrders`
- Parameters:
  - `from` (query, string, optional)
  - `to` (query, string, optional)
  - `login` (query, string, optional)
  - `symbol` (query, string, optional)
  - `account` (query, string, optional)
  - `riskAccount` (query, string, optional)
  - `group` (query, string, optional)
  - `order` (query, string, optional)
  - `cenOrdId` (query, string, optional)
  - `execution` (query, string, optional)
  - `markupModels` (query, string, optional)
- Responses: 200

### `GET /DealMatch/Run`
- Parameters:
  - `group` (query, string, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
  - `symbol` (query, string, optional)
- Responses: 200

## Group

### `GET /Group/GetAllGroups`
- Responses: 200

### `GET /Group/GetGroup`
- Parameters:
  - `group` (query, string, optional)
- Responses: 200

### `GET /Group/GetGroupByLogin`
- Parameters:
  - `login` (query, integer, optional)
- Responses: 200

### `GET /Group/TotalGroups`
- Responses: 200

## History

### `GET /History/aggregate`
- Parameters:
  - `from` (query, integer, optional)
  - `to` (query, integer, optional)
- Responses: 200

### `GET /History/deals`
- Parameters:
  - `login` (query, integer, optional)
  - `from` (query, integer, optional)
  - `to` (query, integer, optional)
- Responses: 200

### `PUT /History/lp-config/{lpName}`
- Parameters:
  - `lpName` (path, string, required)
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

### `GET /History/volume`
- Parameters:
  - `from` (query, integer, optional)
  - `to` (query, integer, optional)
- Responses: 200

## LpAccount

### `GET /api/LpAccount`
- Parameters:
  - `all` (query, boolean, optional)
- Responses: 200

### `POST /api/LpAccount`
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

### `GET /api/LpAccount/by-lp/{lpName}`
- Parameters:
  - `lpName` (path, string, required)
- Responses: 200

### `DELETE /api/LpAccount/{id}`
- Parameters:
  - `id` (path, integer, required)
  - `permanent` (query, boolean, optional)
- Responses: 200

### `GET /api/LpAccount/{id}`
- Parameters:
  - `id` (path, integer, required)
- Responses: 200

### `PUT /api/LpAccount/{id}`
- Parameters:
  - `id` (path, integer, required)
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

## LpInfo

### `GET /api/LpInfo`
- Responses: 200

### `POST /api/LpInfo`
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

### `POST /api/LpInfo/import`
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

### `DELETE /api/LpInfo/{id}`
- Parameters:
  - `id` (path, integer, required)
- Responses: 200

### `GET /api/LpInfo/{id}`
- Parameters:
  - `id` (path, integer, required)
- Responses: 200

### `PUT /api/LpInfo/{id}`
- Parameters:
  - `id` (path, integer, required)
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

## Metrics

### `GET /Metrics/equity-summary`
- Responses: 200

### `GET /Metrics/lp`
- Responses: 200

## Position

### `GET /Position/GetPositionsByGroup`
- Parameters:
  - `group` (query, string, optional)
- Responses: 200

### `GET /Position/GetPositionsByGroupSymbol`
- Parameters:
  - `group` (query, string, optional)
  - `symbol` (query, string, optional)
- Responses: 200

### `GET /Position/GetPositionsByLogin`
- Parameters:
  - `login` (query, integer, optional)
- Responses: 200

### `GET /Position/GetPositionsByLogins`
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

### `GET /Position/GetPositionsBySymbol`
- Parameters:
  - `symbol` (query, string, optional)
- Responses: 200

### `GET /Position/GetPositionsByTicket`
- Parameters:
  - `ticket` (query, integer, optional)
- Responses: 200

### `GET /Position/GetPositionsByTickets`
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

## Report

### `GET /Report/GetCategorizedDealsByGroup`
- Parameters:
  - `group` (query, string, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
  - `page` (query, integer, optional)
  - `pageSize` (query, integer, optional)
- Responses: 200

### `GET /Report/GetCategorizedDealsByLogin`
- Parameters:
  - `login` (query, integer, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
  - `page` (query, integer, optional)
  - `pageSize` (query, integer, optional)
- Responses: 200

### `GET /Report/GetDailyByGroup`
- Parameters:
  - `group` (query, string, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
  - `light` (query, boolean, optional)
- Responses: 200

### `GET /Report/GetDailyByLogin`
- Parameters:
  - `login` (query, integer, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
  - `light` (query, boolean, optional)
- Responses: 200

### `GET /Report/GetDailyByLogins`
- Parameters:
  - `from` (query, string, optional)
  - `to` (query, string, optional)
  - `light` (query, boolean, optional)
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

### `GET /Report/GetSummaryByGroup`
- Parameters:
  - `group` (query, string, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
- Responses: 200

### `GET /Report/GetSummaryByLogin`
- Parameters:
  - `login` (query, integer, optional)
  - `from` (query, string, optional)
  - `to` (query, string, optional)
- Responses: 200

## Swap

### `GET /Swap/diagnostics`
- Responses: 200

### `GET /Swap/positions`
- Responses: 200

### `GET /Swap/rates`
- Responses: 200

### `GET /Swap/rates/csv`
- Responses: 200

## SymbolMapping

### `GET /api/SymbolMapping`
- Responses: 200

### `POST /api/SymbolMapping`
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

### `DELETE /api/SymbolMapping/{id}`
- Parameters:
  - `id` (path, integer, required)
- Responses: 200

### `PUT /api/SymbolMapping/{id}`
- Parameters:
  - `id` (path, integer, required)
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

## TerminalPosition

### `POST /api/TerminalPosition/positions`
- Request body: optional; content: application/*+json, application/json, text/json
- Responses: 200

### `GET /api/TerminalPosition/status`
- Responses: 200
