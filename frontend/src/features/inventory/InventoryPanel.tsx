import { InventoryItem } from "../../shared/api";

type InventoryPanelProps = {
  inventory: InventoryItem[];
  loading: boolean;
  error: string;
  lastUpdated: string | null;
  onRefresh: () => void;
};

export function InventoryPanel({
  inventory,
  loading,
  error,
  lastUpdated,
  onRefresh,
}: InventoryPanelProps) {
  return (
    <section className="panel stock-panel" aria-labelledby="inventory-heading">
      <div className="panel-heading">
        <div>
          <span className="section-index">INVENTORY</span>
          <h2 id="inventory-heading">What you can sell</h2>
        </div>
        <button
          className="refresh"
          onClick={onRefresh}
          aria-label={loading ? "Refreshing inventory" : "Refresh inventory"}
          disabled={loading}
        >↻</button>
      </div>
      <div className="inventory-context">
        <p>Available now <span>·</span> stock can change as orders come in</p>
        {lastUpdated && (
          <span className="updated-time">
            Updated {new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(lastUpdated))}
          </span>
        )}
      </div>
      {error && (
        <div className="notice error inventory-error" role="alert">
          <span>{error}</span>
          <button className="text-action" onClick={onRefresh} disabled={loading}>
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {loading && inventory.length === 0 ? (
        <div className="inventory-loading" role="status">Loading your inventory…</div>
      ) : inventory.length === 0 && !error ? (
        <div className="empty-state">
          <span className="empty-icon" aria-hidden="true">□</span>
          <strong>Your inventory is empty</strong>
          <span>Add products to your catalog, then refresh this page.</span>
        </div>
      ) : (
        <div className="inventory-table" aria-busy={loading}>
          <div className="table-head"><span>ITEM</span><span>SKU</span><span>AVAILABLE</span></div>
          {inventory.map((item) => (
            <div className={`inventory-row ${item.available === 0 ? "inventory-row-out" : ""}`} key={item.sku}>
              <span className="product-name">{item.name}</span>
              <span className="sku">{item.sku}</span>
              <span className={`stock-count ${item.available === 0 ? "out" : ""}`}>
                <i aria-hidden="true" />
                <strong>{item.available.toLocaleString()}</strong>
                <span className="stock-status">{item.available === 0 ? "Sold out" : "In stock"}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="stock-foot">
        <span><i className="legend-dot" /> Available to sell</span>
        <span>{inventory.length} {inventory.length === 1 ? "item" : "items"}</span>
      </div>
    </section>
  );
}
