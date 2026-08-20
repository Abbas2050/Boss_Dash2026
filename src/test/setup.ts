// Fix for Node.js 26+ which exposes a localStorage global that vitest's jsdom
// environment then cannot replace. We substitute a simple in-memory Storage.
//
// The check is for a USABLE storage, not merely a present one: on this Node the
// global is an object whose getItem/setItem/clear are all undefined, so a
// `typeof === "undefined"` guard never fires and the unusable object survives.
// That is what made alarmConfig.test.ts fail with "localStorage.clear is not a
// function" while the global looked perfectly present.

function makeStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    key(index: number): string | null {
      return Object.keys(store)[index] ?? null;
    },
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key: string, value: string): void {
      store[key] = String(value);
    },
    removeItem(key: string): void {
      delete store[key];
    },
    clear(): void {
      store = {};
    },
  };
}

function isUsableStorage(value: unknown): value is Storage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Storage>;
  return (
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function" &&
    typeof candidate.clear === "function"
  );
}

if (!isUsableStorage(globalThis.localStorage)) {
  Object.defineProperty(globalThis, "localStorage", {
    value: makeStorage(),
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
if (!isUsableStorage(globalThis.sessionStorage)) {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: makeStorage(),
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
