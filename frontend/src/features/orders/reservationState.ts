import { CartLine } from "./types";

type ReservationKeys = Record<string, string>;

const RESERVATION_KEYS_STORAGE = "stockroom.pending-reservation-keys.v1";
const RESERVATION_DRAFT_STORAGE = "stockroom.reservation-draft.v1";

export function newCartLine(): CartLine {
  return { id: crypto.randomUUID(), sku: "", quantity: 1 };
}

export function loadReservationDraft(): CartLine[] {
  try {
    const stored = sessionStorage.getItem(RESERVATION_DRAFT_STORAGE);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        const validLines = parsed.filter(
          (line): line is CartLine =>
            typeof line === "object" &&
            line !== null &&
            "id" in line &&
            typeof line.id === "string" &&
            "sku" in line &&
            typeof line.sku === "string" &&
            "quantity" in line &&
            typeof line.quantity === "number" &&
            Number.isFinite(line.quantity) &&
            line.quantity >= 0 &&
            line.quantity <= 100000,
        );
        if (validLines.length) return validLines;
      }
    }
  } catch {
    return [newCartLine()];
  }
  return [newCartLine()];
}

export function saveReservationDraft(cart: CartLine[]) {
  try {
    sessionStorage.setItem(RESERVATION_DRAFT_STORAGE, JSON.stringify(cart));
  } catch {
    // Keep the editable draft in memory when session storage is unavailable.
  }
}

export function loadReservationKeys(): ReservationKeys {
  try {
    const stored = sessionStorage.getItem(RESERVATION_KEYS_STORAGE);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
    }
  } catch {
    return {};
  }
  return {};
}

export function saveReservationKeys(keys: ReservationKeys) {
  try {
    sessionStorage.setItem(RESERVATION_KEYS_STORAGE, JSON.stringify(keys));
  } catch {
    // An in-memory key still protects retries until this page is closed.
  }
}

export function reservationFingerprint(items: Array<{ sku: string; quantity: number }>) {
  return JSON.stringify([...items].sort((a, b) => a.sku.localeCompare(b.sku)));
}

export function getOrCreateReservationKey(keys: ReservationKeys, fingerprint: string) {
  const key = keys[fingerprint] ?? crypto.randomUUID();
  return { key, keys: { ...keys, [fingerprint]: key } };
}

export function withoutReservationKey(keys: ReservationKeys, fingerprint: string) {
  const next = { ...keys };
  delete next[fingerprint];
  return next;
}
