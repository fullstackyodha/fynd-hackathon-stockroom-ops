import { describe, expect, it } from "vitest";

import { ApiError, InventoryItem } from "../../shared/api";
import { getOrderActionError } from "./errorMessages";

describe("operator-facing order errors", () => {
  it("explains stock conflicts using product names and requested/available counts", () => {
    const inventory: InventoryItem[] = [
      {
        sku: "CHAIR-003",
        name: "Oak Side Chair",
        available: 3,
        updated_at: "2026-11-21T00:00:00Z",
      },
    ];
    const error = new ApiError("Request failed (409)", 409, {
      message: "Insufficient inventory.",
      items: [{ sku: "CHAIR-003", requested: 4, available: 3 }],
    });

    expect(getOrderActionError(error, "reserve", new Map(inventory.map((item) => [item.sku, item]))))
      .toBe("Not enough stock to fill this order - Oak Side Chair: 3 available, 4 requested. Adjust the quantities and try again.");
  });

  it("gives a specific not-found recovery for order lookup", () => {
    const error = new ApiError("Order not found.", 404, "Order not found.");

    expect(getOrderActionError(error, "lookup", new Map()))
      .toBe("We couldn't find that order. Check the ID and try again.");
  });
});
