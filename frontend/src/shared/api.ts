const API_BASE =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const API_VERSION = "/api/v1";

export type InventoryItem = {
  sku: string;
  name: string;
  available: number;
  updated_at: string;
};

export type Order = {
  id: string;
  status: "active" | "cancelled";
  created_at: string;
  cancelled_at: string | null;
  items: Array<{ sku: string; name: string; quantity: number }>;
};

type CreateOrderInput = { items: Array<{ sku: string; quantity: number }> };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${API_VERSION}${path}`, init);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail =
      typeof body === "object" && body !== null && "detail" in body ? body.detail : body;
    throw new ApiError(
      typeof detail === "string" ? detail : `Request failed (${response.status})`,
      response.status,
      detail,
    );
  }
  return response.json() as Promise<T>;
}

export const api = {
  inventory: () => request<InventoryItem[]>("/inventory"),
  order: (id: string) => request<Order>(`/orders/${encodeURIComponent(id)}`),
  createOrder: (body: CreateOrderInput, idempotencyKey: string) =>
    request<Order>("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    }),
  cancelOrder: (id: string) =>
    request<Order>(`/orders/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
