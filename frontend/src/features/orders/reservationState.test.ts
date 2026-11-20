import { describe, expect, it } from "vitest";

import {
  getOrCreateReservationKey,
  reservationFingerprint,
  withoutReservationKey,
} from "./reservationState";

describe("reservation idempotency state", () => {
  it("uses the same fingerprint and key when a retry reorders equivalent lines", () => {
    const first = [
      { sku: "LAMP-001", quantity: 2 },
      { sku: "MUG-002", quantity: 1 },
    ];
    const retry = [...first].reverse();
    const fingerprint = reservationFingerprint(first);

    expect(reservationFingerprint(retry)).toBe(fingerprint);
    const initial = getOrCreateReservationKey({}, fingerprint);
    const replay = getOrCreateReservationKey(initial.keys, reservationFingerprint(retry));

    expect(replay.key).toBe(initial.key);
  });

  it("assigns a new key when the reservation payload changes", () => {
    const firstFingerprint = reservationFingerprint([{ sku: "LAMP-001", quantity: 1 }]);
    const changedFingerprint = reservationFingerprint([{ sku: "LAMP-001", quantity: 2 }]);
    const initial = getOrCreateReservationKey({}, firstFingerprint);
    const changed = getOrCreateReservationKey(initial.keys, changedFingerprint);

    expect(changed.key).not.toBe(initial.key);
  });

  it("clears only the completed draft key", () => {
    const keys = {
      first: "key-1",
      second: "key-2",
    };

    expect(withoutReservationKey(keys, "first")).toEqual({ second: "key-2" });
    expect(keys).toEqual({ first: "key-1", second: "key-2" });
  });
});
