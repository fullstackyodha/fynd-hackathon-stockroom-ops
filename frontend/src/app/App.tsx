import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { InventoryPanel } from "../features/inventory/InventoryPanel";
import { getOrderActionError } from "../features/orders/errorMessages";
import { OrderDetailsCard } from "../features/orders/OrderDetailsCard";
import { OrderLookupForm } from "../features/orders/OrderLookupForm";
import { ReservationForm } from "../features/orders/ReservationForm";
import {
  getOrCreateReservationKey,
  loadReservationDraft,
  loadReservationKeys,
  newCartLine,
  reservationFingerprint,
  saveReservationDraft,
  saveReservationKeys,
  withoutReservationKey,
} from "../features/orders/reservationState";
import { CartLine } from "../features/orders/types";
import { api, ApiError, InventoryItem, Order } from "../shared/api";

type BusyAction = "lookup" | "reserve" | "cancel" | null;

function updateOrderUrl(orderId: string | null) {
  const url = new URL(window.location.href);
  if (orderId) url.searchParams.set("order", orderId);
  else url.searchParams.delete("order");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export default function App() {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryError, setInventoryError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [orderId, setOrderId] = useState(
    () => new URLSearchParams(window.location.search).get("order") ?? "",
  );
  const [order, setOrder] = useState<Order | null>(null);
  const [orderError, setOrderError] = useState("");
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [cart, setCart] = useState<CartLine[]>(loadReservationDraft);
  const [notice, setNotice] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reservationKeys, setReservationKeys] = useState(loadReservationKeys);

  const inventoryBySku = useMemo(
    () => new Map(inventory.map((item) => [item.sku, item])),
    [inventory],
  );
  const sellableUnits = inventory.reduce((total, item) => total + item.available, 0);
  const stockedItems = inventory.filter((item) => item.available > 0).length;
  const soldOutItems = inventory.filter((item) => item.available === 0).length;
  const inventorySnapshotUnavailable =
    inventory.length === 0 && (inventoryLoading || Boolean(inventoryError));
  const refreshInventory = useCallback(async () => {
    setInventoryLoading(true);
    try {
      setInventory(await api.inventory());
      setInventoryError("");
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      setInventoryError(
        error instanceof TypeError
          ? "We couldn't reach the inventory service. Check that the API is running, then retry."
          : error instanceof Error
            ? error.message
            : "Inventory couldn't be loaded.",
      );
    } finally {
      setInventoryLoading(false);
    }
  }, []);

  const lookupOrder = useCallback(async (id: string) => {
    setBusyAction("lookup");
    setOrder(null);
    setOrderError("");
    setNotice("");
    setConfirmCancel(false);
    try {
      const result = await api.order(id.trim());
      setOrder(result);
      setOrderId(result.id);
      updateOrderUrl(result.id);
    } catch (error) {
      setOrderError(getOrderActionError(error, "lookup", inventoryBySku));
    } finally {
      setBusyAction(null);
    }
  }, []);

  useEffect(() => {
    void refreshInventory();
  }, [refreshInventory]);

  useEffect(() => {
    saveReservationDraft(cart);
  }, [cart]);

  useEffect(() => {
    const initialOrderId = new URLSearchParams(window.location.search).get("order");
    if (initialOrderId) void lookupOrder(initialOrderId);
  }, [lookupOrder]);

  function updateCartLine(id: string, patch: Partial<CartLine>) {
    setCart((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  function addCartLine() {
    setCart((current) => [...current, newCartLine()]);
  }

  function removeCartLine(id: string) {
    setCart((current) => current.filter((line) => line.id !== id));
  }

  function getReservationKey(fingerprint: string) {
    const result = getOrCreateReservationKey(reservationKeys, fingerprint);
    setReservationKeys(result.keys);
    saveReservationKeys(result.keys);
    return result.key;
  }

  function clearReservationKey(fingerprint: string) {
    const next = withoutReservationKey(reservationKeys, fingerprint);
    setReservationKeys(next);
    saveReservationKeys(next);
  }

  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!orderId.trim()) return;
    await lookupOrder(orderId);
  }

  async function reserve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      cart.length === 0 ||
      cart.some((line) => !line.sku || !Number.isInteger(line.quantity) || line.quantity < 1)
    ) {
      setOrderError("Choose an item and enter a whole-number quantity of at least one for every line.");
      return;
    }
    const items = cart.map(({ sku, quantity }) => ({ sku, quantity }));
    if (new Set(items.map((item) => item.sku)).size !== items.length) {
      setOrderError("Each item can appear only once. Update the quantity on its existing line.");
      return;
    }

    const fingerprint = reservationFingerprint(items);
    setBusyAction("reserve");
    setOrder(null);
    setOrderError("");
    setNotice("");
    setConfirmCancel(false);
    try {
      const result = await api.createOrder({ items }, getReservationKey(fingerprint));
      clearReservationKey(fingerprint);
      setOrder(result);
      setOrderId(result.id);
      updateOrderUrl(result.id);
      setNotice("Reservation confirmed. Its order ID is saved in this page's link.");
      const emptyCart = [newCartLine()];
      saveReservationDraft(emptyCart);
      setCart(emptyCart);
      await refreshInventory();
    } catch (error) {
      setOrderError(getOrderActionError(error, "reserve", inventoryBySku));
      if (error instanceof ApiError && error.status === 409) await refreshInventory();
    } finally {
      setBusyAction(null);
    }
  }

  async function cancel() {
    if (!order || order.status !== "active") return;
    setBusyAction("cancel");
    setOrderError("");
    setNotice("");
    try {
      setOrder(await api.cancelOrder(order.id));
      setConfirmCancel(false);
      setNotice("Order cancelled. Reserved units are available to sell again.");
      await refreshInventory();
    } catch (error) {
      setOrderError(getOrderActionError(error, "cancel", inventoryBySku));
    } finally {
      setBusyAction(null);
    }
  }

  async function copyOrderId() {
    if (!order) return;
    try {
      await navigator.clipboard.writeText(order.id);
      setNotice("Order ID copied.");
    } catch {
      setNotice("Copy isn't available in this browser. Select the order ID to copy it.");
    }
  }

  const anyBusy = busyAction !== null;

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Stockroom home">
          <span className="brand-mark">s.</span>
          <span>stockroom<span className="brand-dot">/</span>ops</span>
        </a>
        <div className="top-meta"><span className="live-dot" /> OPERATIONS</div>
      </header>

      <section className="intro">
        <div className="intro-copy-block">
          <p className="eyebrow">MERCHANT OPERATIONS <span>—</span> STOCK INTEGRITY</p>
          <h1>One unit.<br /><em>One promise.</em></h1>
          <p className="intro-copy">
            Reserve every item or none. Find an order, check live stock, and release
            a reservation with confidence.
          </p>
        </div>
        <aside className="hero-brief" aria-label="Live inventory snapshot">
          <div className="hero-brief-kicker"><span className="live-dot" /> LIVE STOCK SNAPSHOT</div>
          <div className="hero-total">
            <strong>{inventorySnapshotUnavailable ? "—" : sellableUnits.toLocaleString()}</strong>
            <span>SELLABLE UNITS</span>
          </div>
          <div className="hero-stats">
            <div><strong>{inventorySnapshotUnavailable ? "—" : stockedItems}</strong><span>IN STOCK</span></div>
            <div><strong>{inventorySnapshotUnavailable ? "—" : soldOutItems}</strong><span>SOLD OUT</span></div>
          </div>
          <p className="hero-brief-note">Atomic reservations / exact releases</p>
        </aside>
      </section>

      <div className="workspace">
        <section className="panel order-panel" aria-labelledby="orders-heading">
          <div className="panel-heading">
            <div>
              <span className="section-index">ORDERS</span>
              <h2 id="orders-heading">Find or reserve</h2>
            </div>
            <span className="heading-icon" aria-hidden="true">↗</span>
          </div>

          <OrderLookupForm
            orderId={orderId}
            busy={anyBusy}
            finding={busyAction === "lookup"}
            onOrderIdChange={setOrderId}
            onSubmit={lookup}
          />
          <div className="divider"><span>NEW RESERVATION</span></div>
          <ReservationForm
            cart={cart}
            inventory={inventory}
            busy={anyBusy}
            submitting={busyAction === "reserve"}
            inventoryLoading={inventoryLoading}
            inventoryError={inventoryError}
            onCartLineChange={updateCartLine}
            onAddLine={addCartLine}
            onRemoveLine={removeCartLine}
            onSubmit={reserve}
          />

          {orderError && (
            <div className="notice error" role="alert">
              <span>{orderError}</span>
              {busyAction === null && orderId.trim() && orderError.includes("find that order") && (
                <button className="text-action" onClick={() => void lookupOrder(orderId)}>Try again</button>
              )}
            </div>
          )}
          {notice && <p className="notice success" role="status">{notice}</p>}

          {order && (
            <OrderDetailsCard
              order={order}
              busy={anyBusy}
              cancelling={busyAction === "cancel"}
              confirmCancel={confirmCancel}
              onCopyOrderId={() => void copyOrderId()}
              onRequestCancel={() => setConfirmCancel(true)}
              onDismissCancel={() => setConfirmCancel(false)}
              onConfirmCancel={() => void cancel()}
            />
          )}
        </section>

        <InventoryPanel
          inventory={inventory}
          loading={inventoryLoading}
          error={inventoryError}
          lastUpdated={lastUpdated}
          onRefresh={() => void refreshInventory()}
        />
      </div>

      <footer>
        <span>STOCKROOM <b>·</b> ORDER OPERATIONS</span>
        <span>YOUR RESERVATION IS CONFIRMED ONLY AFTER SUCCESS</span>
      </footer>
    </main>
  );
}
