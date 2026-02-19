export const ALERT_EVENT_KEYS = [
  "UserChangeAlert",
  "AccountAlert",
  "PositionMatchTableUpdate",
  "DealUpdate",
  "PositionUpdate",
  "OrderUpdate",
  "TransactionAlert",
] as const;

export type AlertEventKey = (typeof ALERT_EVENT_KEYS)[number];

export const ALERT_EVENT_META: Record<
  AlertEventKey,
  { title: string; description: string }
> = {
  UserChangeAlert: {
    title: "User Change",
    description: "New/updated/deleted user account activity.",
  },
  AccountAlert: {
    title: "Account Risk Alert",
    description: "Margin call/stop-out updates from account monitoring.",
  },
  PositionMatchTableUpdate: {
    title: "Position Match Update",
    description: "Coverage position-match table was refreshed.",
  },
  DealUpdate: {
    title: "Deal Update",
    description: "A deal execution update was published.",
  },
  PositionUpdate: {
    title: "Position Update",
    description: "A trading position changed.",
  },
  OrderUpdate: {
    title: "Order Update",
    description: "Order state changed (new/update/cancel/fill).",
  },
  TransactionAlert: {
    title: "Transaction Alert",
    description: "A balance transaction notification arrived.",
  },
};

const STORAGE_KEY = "slc.alert.preferences.v1";
const CHANGE_EVENT = "slc-alert-preferences-updated";

export type AlertPreferences = Record<AlertEventKey, boolean>;

export function getDefaultAlertPreferences(): AlertPreferences {
  return {
    UserChangeAlert: true,
    AccountAlert: true,
    PositionMatchTableUpdate: false,
    DealUpdate: false,
    PositionUpdate: false,
    OrderUpdate: false,
    TransactionAlert: true,
  };
}

export function readAlertPreferences(): AlertPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultAlertPreferences();
    const parsed = JSON.parse(raw) as Partial<AlertPreferences>;
    const defaults = getDefaultAlertPreferences();
    for (const key of ALERT_EVENT_KEYS) {
      if (typeof parsed[key] === "boolean") defaults[key] = parsed[key] as boolean;
    }
    return defaults;
  } catch {
    return getDefaultAlertPreferences();
  }
}

export function writeAlertPreferences(next: AlertPreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
}

export function onAlertPreferencesChanged(
  handler: (prefs: AlertPreferences) => void
): () => void {
  const listener = (ev: Event) => {
    const custom = ev as CustomEvent<AlertPreferences>;
    if (custom.detail) {
      handler(custom.detail);
      return;
    }
    handler(readAlertPreferences());
  };
  window.addEventListener(CHANGE_EVENT, listener as EventListener);
  window.addEventListener("storage", listener as EventListener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener as EventListener);
    window.removeEventListener("storage", listener as EventListener);
  };
}
