// Auto-generated from Swagger. Do not edit manually.
export const SWAGGER_META = {
  "source": "http://50.28.86.170/swagger/v1/swagger.json",
  "title": "SLCDashboard",
  "version": "1.0",
  "fetchedAt": "2026-02-24T09:01:28.552634Z",
  "endpointCount": 65
};

export const SWAGGER_ENDPOINTS = [
  {
    "id": "get /Account/GetAccountByLogin",
    "method": "get",
    "path": "/Account/GetAccountByLogin",
    "tag": "Account",
    "summary": "",
    "parameters": [
      {
        "name": "login",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Account/GetAccountsByGroup",
    "method": "get",
    "path": "/Account/GetAccountsByGroup",
    "tag": "Account",
    "summary": "",
    "parameters": [
      {
        "name": "path",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Account/GetAllAccounts",
    "method": "get",
    "path": "/Account/GetAllAccounts",
    "tag": "Account",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Account/GetUserInfo",
    "method": "get",
    "path": "/Account/GetUserInfo",
    "tag": "Account",
    "summary": "",
    "parameters": [
      {
        "name": "login",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "get /Account/GetUserInfoBatch",
    "method": "get",
    "path": "/Account/GetUserInfoBatch",
    "tag": "Account",
    "summary": "",
    "parameters": [
      {
        "name": "logins",
        "in": "query",
        "required": false,
        "type": "array",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "get /Coverage/dashboard",
    "method": "get",
    "path": "/Coverage/dashboard",
    "tag": "Coverage",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Coverage/dashboard/{baseSymbol}",
    "method": "get",
    "path": "/Coverage/dashboard/{baseSymbol}",
    "tag": "Coverage",
    "summary": "",
    "parameters": [
      {
        "name": "baseSymbol",
        "in": "path",
        "required": true,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Coverage/lp/{lpName}/positions",
    "method": "get",
    "path": "/Coverage/lp/{lpName}/positions",
    "tag": "Coverage",
    "summary": "",
    "parameters": [
      {
        "name": "lpName",
        "in": "path",
        "required": true,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Coverage/position-match-table",
    "method": "get",
    "path": "/Coverage/position-match-table",
    "tag": "Coverage",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Coverage/summary",
    "method": "get",
    "path": "/Coverage/summary",
    "tag": "Coverage",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Deal/GetDealsByGroup",
    "method": "get",
    "path": "/Deal/GetDealsByGroup",
    "tag": "Deal",
    "summary": "",
    "parameters": [
      {
        "name": "group",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Deal/GetDealsByGroupSymbol",
    "method": "get",
    "path": "/Deal/GetDealsByGroupSymbol",
    "tag": "Deal",
    "summary": "",
    "parameters": [
      {
        "name": "group",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "symbol",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Deal/GetDealsByLogin",
    "method": "get",
    "path": "/Deal/GetDealsByLogin",
    "tag": "Deal",
    "summary": "",
    "parameters": [
      {
        "name": "login",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Deal/GetDealsByLogins",
    "method": "get",
    "path": "/Deal/GetDealsByLogins",
    "tag": "Deal",
    "summary": "",
    "parameters": [
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Deal/GetDealsByLoginsSymbol",
    "method": "get",
    "path": "/Deal/GetDealsByLoginsSymbol",
    "tag": "Deal",
    "summary": "",
    "parameters": [
      {
        "name": "symbol",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Deal/GetDealsByTickets",
    "method": "get",
    "path": "/Deal/GetDealsByTickets",
    "tag": "Deal",
    "summary": "",
    "parameters": [],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Deal/GetTransactions",
    "method": "get",
    "path": "/Deal/GetTransactions",
    "tag": "Deal",
    "summary": "",
    "parameters": [
      {
        "name": "login",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      },
      {
        "name": "group",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "action",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "get /DealMatch/CentroidOrders",
    "method": "get",
    "path": "/DealMatch/CentroidOrders",
    "tag": "DealMatch",
    "summary": "",
    "parameters": [
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "login",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "symbol",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "account",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "riskAccount",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "group",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "order",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "cenOrdId",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "execution",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "markupModels",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "get /DealMatch/Run",
    "method": "get",
    "path": "/DealMatch/Run",
    "tag": "DealMatch",
    "summary": "",
    "parameters": [
      {
        "name": "group",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "symbol",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Group/GetAllGroups",
    "method": "get",
    "path": "/Group/GetAllGroups",
    "tag": "Group",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Group/GetGroup",
    "method": "get",
    "path": "/Group/GetGroup",
    "tag": "Group",
    "summary": "",
    "parameters": [
      {
        "name": "group",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Group/GetGroupByLogin",
    "method": "get",
    "path": "/Group/GetGroupByLogin",
    "tag": "Group",
    "summary": "",
    "parameters": [
      {
        "name": "login",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Group/TotalGroups",
    "method": "get",
    "path": "/Group/TotalGroups",
    "tag": "Group",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /History/aggregate",
    "method": "get",
    "path": "/History/aggregate",
    "tag": "History",
    "summary": "",
    "parameters": [
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /History/deals",
    "method": "get",
    "path": "/History/deals",
    "tag": "History",
    "summary": "",
    "parameters": [
      {
        "name": "login",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "put /History/lp-config/{lpName}",
    "method": "put",
    "path": "/History/lp-config/{lpName}",
    "tag": "History",
    "summary": "",
    "parameters": [
      {
        "name": "lpName",
        "in": "path",
        "required": true,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "get /History/volume",
    "method": "get",
    "path": "/History/volume",
    "tag": "History",
    "summary": "",
    "parameters": [
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /api/LpAccount",
    "method": "get",
    "path": "/api/LpAccount",
    "tag": "LpAccount",
    "summary": "",
    "parameters": [
      {
        "name": "all",
        "in": "query",
        "required": false,
        "type": "boolean",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "post /api/LpAccount",
    "method": "post",
    "path": "/api/LpAccount",
    "tag": "LpAccount",
    "summary": "",
    "parameters": [],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /api/LpAccount/by-lp/{lpName}",
    "method": "get",
    "path": "/api/LpAccount/by-lp/{lpName}",
    "tag": "LpAccount",
    "summary": "",
    "parameters": [
      {
        "name": "lpName",
        "in": "path",
        "required": true,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "delete /api/LpAccount/{id}",
    "method": "delete",
    "path": "/api/LpAccount/{id}",
    "tag": "LpAccount",
    "summary": "",
    "parameters": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "type": "integer",
        "description": ""
      },
      {
        "name": "permanent",
        "in": "query",
        "required": false,
        "type": "boolean",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "get /api/LpAccount/{id}",
    "method": "get",
    "path": "/api/LpAccount/{id}",
    "tag": "LpAccount",
    "summary": "",
    "parameters": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "put /api/LpAccount/{id}",
    "method": "put",
    "path": "/api/LpAccount/{id}",
    "tag": "LpAccount",
    "summary": "",
    "parameters": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /api/LpInfo",
    "method": "get",
    "path": "/api/LpInfo",
    "tag": "LpInfo",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "post /api/LpInfo",
    "method": "post",
    "path": "/api/LpInfo",
    "tag": "LpInfo",
    "summary": "",
    "parameters": [],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "post /api/LpInfo/import",
    "method": "post",
    "path": "/api/LpInfo/import",
    "tag": "LpInfo",
    "summary": "",
    "parameters": [],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "delete /api/LpInfo/{id}",
    "method": "delete",
    "path": "/api/LpInfo/{id}",
    "tag": "LpInfo",
    "summary": "",
    "parameters": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "get /api/LpInfo/{id}",
    "method": "get",
    "path": "/api/LpInfo/{id}",
    "tag": "LpInfo",
    "summary": "",
    "parameters": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "put /api/LpInfo/{id}",
    "method": "put",
    "path": "/api/LpInfo/{id}",
    "tag": "LpInfo",
    "summary": "",
    "parameters": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Metrics/equity-summary",
    "method": "get",
    "path": "/Metrics/equity-summary",
    "tag": "Metrics",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Metrics/lp",
    "method": "get",
    "path": "/Metrics/lp",
    "tag": "Metrics",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Position/GetPositionsByGroup",
    "method": "get",
    "path": "/Position/GetPositionsByGroup",
    "tag": "Position",
    "summary": "",
    "parameters": [
      {
        "name": "group",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Position/GetPositionsByGroupSymbol",
    "method": "get",
    "path": "/Position/GetPositionsByGroupSymbol",
    "tag": "Position",
    "summary": "",
    "parameters": [
      {
        "name": "group",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "symbol",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Position/GetPositionsByLogin",
    "method": "get",
    "path": "/Position/GetPositionsByLogin",
    "tag": "Position",
    "summary": "",
    "parameters": [
      {
        "name": "login",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Position/GetPositionsByLogins",
    "method": "get",
    "path": "/Position/GetPositionsByLogins",
    "tag": "Position",
    "summary": "",
    "parameters": [],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Position/GetPositionsBySymbol",
    "method": "get",
    "path": "/Position/GetPositionsBySymbol",
    "tag": "Position",
    "summary": "",
    "parameters": [
      {
        "name": "symbol",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Position/GetPositionsByTicket",
    "method": "get",
    "path": "/Position/GetPositionsByTicket",
    "tag": "Position",
    "summary": "",
    "parameters": [
      {
        "name": "ticket",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Position/GetPositionsByTickets",
    "method": "get",
    "path": "/Position/GetPositionsByTickets",
    "tag": "Position",
    "summary": "",
    "parameters": [],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Report/GetCategorizedDealsByGroup",
    "method": "get",
    "path": "/Report/GetCategorizedDealsByGroup",
    "tag": "Report",
    "summary": "",
    "parameters": [
      {
        "name": "group",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "page",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      },
      {
        "name": "pageSize",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Report/GetCategorizedDealsByLogin",
    "method": "get",
    "path": "/Report/GetCategorizedDealsByLogin",
    "tag": "Report",
    "summary": "",
    "parameters": [
      {
        "name": "login",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "page",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      },
      {
        "name": "pageSize",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Report/GetDailyByGroup",
    "method": "get",
    "path": "/Report/GetDailyByGroup",
    "tag": "Report",
    "summary": "",
    "parameters": [
      {
        "name": "group",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "light",
        "in": "query",
        "required": false,
        "type": "boolean",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Report/GetDailyByLogin",
    "method": "get",
    "path": "/Report/GetDailyByLogin",
    "tag": "Report",
    "summary": "",
    "parameters": [
      {
        "name": "login",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "light",
        "in": "query",
        "required": false,
        "type": "boolean",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Report/GetDailyByLogins",
    "method": "get",
    "path": "/Report/GetDailyByLogins",
    "tag": "Report",
    "summary": "",
    "parameters": [
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "light",
        "in": "query",
        "required": false,
        "type": "boolean",
        "description": ""
      }
    ],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Report/GetSummaryByGroup",
    "method": "get",
    "path": "/Report/GetSummaryByGroup",
    "tag": "Report",
    "summary": "",
    "parameters": [
      {
        "name": "group",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Report/GetSummaryByLogin",
    "method": "get",
    "path": "/Report/GetSummaryByLogin",
    "tag": "Report",
    "summary": "",
    "parameters": [
      {
        "name": "login",
        "in": "query",
        "required": false,
        "type": "integer",
        "description": ""
      },
      {
        "name": "from",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      },
      {
        "name": "to",
        "in": "query",
        "required": false,
        "type": "string",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Swap/diagnostics",
    "method": "get",
    "path": "/Swap/diagnostics",
    "tag": "Swap",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "get /Swap/positions",
    "method": "get",
    "path": "/Swap/positions",
    "tag": "Swap",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Swap/rates",
    "method": "get",
    "path": "/Swap/rates",
    "tag": "Swap",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "get /Swap/rates/csv",
    "method": "get",
    "path": "/Swap/rates/csv",
    "tag": "Swap",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "get /api/SymbolMapping",
    "method": "get",
    "path": "/api/SymbolMapping",
    "tag": "SymbolMapping",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "post /api/SymbolMapping",
    "method": "post",
    "path": "/api/SymbolMapping",
    "tag": "SymbolMapping",
    "summary": "",
    "parameters": [],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "delete /api/SymbolMapping/{id}",
    "method": "delete",
    "path": "/api/SymbolMapping/{id}",
    "tag": "SymbolMapping",
    "summary": "",
    "parameters": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "put /api/SymbolMapping/{id}",
    "method": "put",
    "path": "/api/SymbolMapping/{id}",
    "tag": "SymbolMapping",
    "summary": "",
    "parameters": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "type": "integer",
        "description": ""
      }
    ],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": [
          "application/json",
          "text/json",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "post /api/TerminalPosition/positions",
    "method": "post",
    "path": "/api/TerminalPosition/positions",
    "tag": "TerminalPosition",
    "summary": "",
    "parameters": [],
    "requestBody": {
      "required": false,
      "contentTypes": [
        "application/*+json",
        "application/json",
        "text/json"
      ]
    },
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  },
  {
    "id": "get /api/TerminalPosition/status",
    "method": "get",
    "path": "/api/TerminalPosition/status",
    "tag": "TerminalPosition",
    "summary": "",
    "parameters": [],
    "requestBody": {},
    "responses": [
      {
        "status": "200",
        "description": "OK",
        "contentTypes": []
      }
    ]
  }
];
