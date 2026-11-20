import { FormEvent } from "react";

type OrderLookupFormProps = {
  orderId: string;
  busy: boolean;
  finding: boolean;
  onOrderIdChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function OrderLookupForm({
  orderId,
  busy,
  finding,
  onOrderIdChange,
  onSubmit,
}: OrderLookupFormProps) {
  return (
    <form className="lookup-form" onSubmit={onSubmit}>
      <label htmlFor="order-id">LOOK UP AN EXISTING ORDER</label>
      <div className="input-row">
        <input
          id="order-id"
          value={orderId}
          onChange={(event) => onOrderIdChange(event.target.value)}
          placeholder="Paste an order ID"
          autoComplete="off"
          disabled={busy}
          required
        />
        <button className="button button-dark" disabled={busy}>
          {finding ? "Finding…" : "Find order"} <span aria-hidden="true">→</span>
        </button>
      </div>
    </form>
  );
}
