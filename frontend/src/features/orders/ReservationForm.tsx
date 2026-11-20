import { FormEvent } from "react";

import { InventoryItem } from "../../shared/api";
import { CartLine } from "./types";

type ReservationFormProps = {
  cart: CartLine[];
  inventory: InventoryItem[];
  busy: boolean;
  submitting: boolean;
  inventoryLoading: boolean;
  inventoryError: string;
  onCartLineChange: (id: string, patch: Partial<CartLine>) => void;
  onAddLine: () => void;
  onRemoveLine: (id: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function ReservationForm({
  cart,
  inventory,
  busy,
  submitting,
  inventoryLoading,
  inventoryError,
  onCartLineChange,
  onAddLine,
  onRemoveLine,
  onSubmit,
}: ReservationFormProps) {
  const totalUnits = cart.reduce(
    (total, line) => total + (Number.isFinite(line.quantity) ? line.quantity : 0),
    0,
  );
  const availableItems = inventory.filter((item) => item.available > 0);
  const soldOutItems = inventory.filter((item) => item.available === 0);

  return (
    <form className="reserve-form" onSubmit={onSubmit}>
      <p className="form-hint">
        Add one or more items. The draft stays in this tab if you need to retry or refresh.
      </p>
      <div className="cart-lines">
        {cart.map((line, index) => {
          const item = inventory.find((candidate) => candidate.sku === line.sku);
          const selectedByOtherLine = new Set(
            cart.filter((candidate) => candidate.id !== line.id).map((candidate) => candidate.sku),
          );
          return (
            <div className="cart-line" key={line.id}>
              <label className="visually-hidden" htmlFor={`sku-${line.id}`}>Item {index + 1}</label>
              <select
                id={`sku-${line.id}`}
                value={line.sku}
                onChange={(event) => onCartLineChange(line.id, { sku: event.target.value })}
                disabled={busy}
                required
              >
                <option value="" disabled>Choose an item</option>
                {availableItems.length > 0 && (
                  <optgroup label="READY TO RESERVE">
                    {availableItems.map((candidate) => (
                      <option
                        key={candidate.sku}
                        value={candidate.sku}
                        disabled={selectedByOtherLine.has(candidate.sku)}
                      >
                        {candidate.name} · {candidate.available === 1 ? "LAST UNIT" : `${candidate.available} AVAILABLE`}
                      </option>
                    ))}
                  </optgroup>
                )}
                {soldOutItems.length > 0 && (
                  <optgroup label="CURRENTLY SOLD OUT">
                    {soldOutItems.map((candidate) => (
                      <option key={candidate.sku} value={candidate.sku} disabled>
                        {candidate.name} · OUT OF STOCK
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <label className="visually-hidden" htmlFor={`quantity-${line.id}`}>
                Quantity for item {index + 1}
              </label>
              <input
                id={`quantity-${line.id}`}
                className="quantity-input"
                type="number"
                min={1}
                max={100000}
                step={1}
                inputMode="numeric"
                aria-label={`Quantity for item ${index + 1}`}
                value={line.quantity}
                onChange={(event) =>
                  onCartLineChange(line.id, {
                    quantity: event.target.value === "" ? 0 : Number(event.target.value),
                  })
                }
                disabled={busy}
                required
              />
              {item && (
                <span className={`line-availability ${item.available === 0 ? "out" : ""}`}>
                  {item.available} available
                </span>
              )}
              {cart.length > 1 ? (
                <button
                  type="button"
                  className="remove-line"
                  onClick={() => onRemoveLine(line.id)}
                  disabled={busy}
                  aria-label={`Remove item ${index + 1}`}
                  title="Remove item"
                >×</button>
              ) : <span className="line-spacer" aria-hidden="true" />}
            </div>
          );
        })}
      </div>
      <div className="cart-actions">
        <button
          type="button"
          className="add-line"
          onClick={onAddLine}
          disabled={busy || cart.length >= inventory.length}
        >
          <span aria-hidden="true">＋</span> Add another item
        </button>
        <span className="unit-count">{totalUnits} {totalUnits === 1 ? "unit" : "units"}</span>
      </div>
      {inventory.length === 0 && !inventoryLoading && !inventoryError && (
        <p className="notice neutral">No items are available yet. Seed inventory, then refresh.</p>
      )}
      <button
        className="button button-accent reserve-button"
        type="submit"
        disabled={busy || inventoryLoading || inventory.length === 0}
      >
        {submitting ? "Confirming reservation…" : "Reserve stock"}
        <span aria-hidden="true">→</span>
      </button>
    </form>
  );
}
