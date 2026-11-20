import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  inventory: vi.fn(),
  order: vi.fn(),
  createOrder: vi.fn(),
  cancelOrder: vi.fn(),
}));

vi.mock("../shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api")>();
  return { ...actual, api: apiMocks };
});

import App from "./App";
import { InventoryItem, Order } from "../shared/api";

const inventory: InventoryItem[] = [
  {
    sku: "LAMP-001",
    name: "Arc Desk Lamp",
    available: 8,
    updated_at: "2026-11-21T00:00:00Z",
  },
  {
    sku: "MUG-002",
    name: "Stoneware Mug",
    available: 25,
    updated_at: "2026-11-21T00:00:00Z",
  },
  {
    sku: "SOLD-OUT",
    name: "Retired Sample",
    available: 0,
    updated_at: "2026-11-21T00:00:00Z",
  },
];

const activeOrder: Order = {
  id: "41f7eb3e-3431-43ba-bf3d-bd1f6c32923f",
  status: "active",
  created_at: "2026-11-21T00:00:00Z",
  cancelled_at: null,
  items: [{ sku: "LAMP-001", name: "Arc Desk Lamp", quantity: 2 }],
};

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.clearAllMocks();
  apiMocks.inventory.mockResolvedValue(inventory);
  apiMocks.order.mockResolvedValue(activeOrder);
});

afterEach(cleanup);

describe("operator order workflow", () => {
  it("shows a live summary of the available inventory", async () => {
    render(<App />);

    const snapshot = await screen.findByRole("complementary", { name: "Live inventory snapshot" });

    expect(snapshot).toHaveTextContent("33");
    expect(snapshot).toHaveTextContent(/2\s*IN STOCK/);
    expect(snapshot).toHaveTextContent(/1\s*SOLD OUT/);
  });

  it("does not report zero stock when the inventory service is unavailable", async () => {
    apiMocks.inventory.mockRejectedValueOnce(new TypeError("Network unavailable"));
    render(<App />);

    const snapshot = await screen.findByRole("complementary", { name: "Live inventory snapshot" });
    await screen.findByRole("alert");

    expect(snapshot).toHaveTextContent("—");
    expect(snapshot).not.toHaveTextContent("0");
  });

  it("retries an uncertain reservation with the same key and payload", async () => {
    const user = userEvent.setup();
    apiMocks.createOrder
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(activeOrder);

    render(<App />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Item 1" }), "LAMP-001");
    await user.clear(screen.getByRole("spinbutton", { name: "Quantity for item 1" }));
    await user.type(screen.getByRole("spinbutton", { name: "Quantity for item 1" }), "2");
    await user.click(screen.getByRole("button", { name: "Reserve stock" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("your reservation draft is still here");
    const savedDraft = JSON.parse(sessionStorage.getItem("stockroom.reservation-draft.v1") ?? "[]");
    expect(savedDraft).toMatchObject([{ sku: "LAMP-001", quantity: 2 }]);

    await user.click(screen.getByRole("button", { name: "Reserve stock" }));
    await waitFor(() => expect(apiMocks.createOrder).toHaveBeenCalledTimes(2));

    expect(apiMocks.createOrder.mock.calls[0][0]).toEqual(apiMocks.createOrder.mock.calls[1][0]);
    expect(apiMocks.createOrder.mock.calls[0][1]).toBe(apiMocks.createOrder.mock.calls[1][1]);
    expect(await screen.findByRole("article", { name: "Order details" })).toHaveTextContent(
      activeOrder.id,
    );
    expect(new URLSearchParams(window.location.search).get("order")).toBe(activeOrder.id);
    expect(JSON.parse(sessionStorage.getItem("stockroom.pending-reservation-keys.v1") ?? "{}"))
      .toEqual({});
  });

  it("requires confirmation before cancelling and shows the persisted terminal state", async () => {
    const user = userEvent.setup();
    const cancelledOrder: Order = {
      ...activeOrder,
      status: "cancelled",
      cancelled_at: "2026-11-21T00:05:00Z",
    };
    window.history.replaceState({}, "", `/?order=${activeOrder.id}`);
    apiMocks.cancelOrder.mockResolvedValue(cancelledOrder);

    render(<App />);
    await screen.findByRole("article", { name: "Order details" });
    await user.click(screen.getByRole("button", { name: "Cancel order" }));

    expect(screen.getByRole("alert")).toHaveTextContent("This can't be undone.");
    expect(apiMocks.cancelOrder).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Yes, cancel order" }));

    expect(await screen.findByText("This order is cancelled. Its reserved stock has been released."))
      .toBeInTheDocument();
    expect(apiMocks.cancelOrder).toHaveBeenCalledOnce();
    expect(apiMocks.cancelOrder).toHaveBeenCalledWith(activeOrder.id);
  });
});
