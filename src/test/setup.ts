// Fix for Node.js 26+ which has a configurable but undefined localStorage global
// that prevents vitest's jsdom environment from injecting localStorage.
// We create a simple in-memory Storage polyfill when localStorage is unavailable.

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

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: makeStorage(),
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
if (typeof globalThis.sessionStorage === "undefined") {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: makeStorage(),
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
