import { Order } from "../../shared/api";

type OrderDetailsCardProps = {
  order: Order;
  busy: boolean;
  cancelling: boolean;
  confirmCancel: boolean;
  onCopyOrderId: () => void;
  onRequestCancel: () => void;
  onDismissCancel: () => void;
  onConfirmCancel: () => void;
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function OrderDetailsCard({
  order,
  busy,
  cancelling,
  confirmCancel,
  onCopyOrderId,
  onRequestCancel,
  onDismissCancel,
  onConfirmCancel,
}: OrderDetailsCardProps) {
  return (
    <article className="order-card" aria-label="Order details">
      <div className="order-card-top">
        <div className="order-title">
          <span className="section-index">ORDER DETAILS</span>
          <h3 title={order.id}>{order.id}</h3>
        </div>
        <span className={`status status-${order.status}`}>
          <i />{order.status === "active" ? "Active" : "Cancelled"}
        </span>
      </div>
      <div className="order-meta">
        <span>Placed {formatTime(order.created_at)}</span>
        <button type="button" className="text-action" onClick={onCopyOrderId}>Copy ID</button>
      </div>
      <div className="order-lines">
        {order.items.map((item) => (
          <div className="order-line" key={item.sku}>
            <span><strong>{item.name}</strong><small>{item.sku}</small></span>
            <span className="line-quantity">Qty {item.quantity}</span>
          </div>
        ))}
      </div>
      {order.status === "cancelled" ? (
        <p className="order-state-note">This order is cancelled. Its reserved stock has been released.</p>
      ) : confirmCancel ? (
        <div className="cancel-confirm" role="alert">
          <strong>Cancel this order?</strong>
          <p>
            {order.items.map((item) => `${item.quantity} ${item.name}`).join(" and ")} will be returned to available stock.
            This can't be undone.
          </p>
          <div className="confirm-actions">
            <button className="button button-quiet" onClick={onDismissCancel} disabled={busy}>
              Keep order
            </button>
            <button className="button button-danger" onClick={onConfirmCancel} disabled={busy}>
              {cancelling ? "Cancelling…" : "Yes, cancel order"}
            </button>
          </div>
        </div>
      ) : (
        <button className="button button-outline" onClick={onRequestCancel} disabled={busy}>
          Cancel order
        </button>
      )}
    </article>
  );
}
