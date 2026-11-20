import { ApiError, InventoryItem } from "../../shared/api";

export function getOrderActionError(
  error: unknown,
  action: "lookup" | "reserve" | "cancel",
  inventoryBySku: ReadonlyMap<string, InventoryItem>,
) {
  if (error instanceof ApiError) {
    if (action === "lookup" && error.status === 404) {
      return "We couldn't find that order. Check the ID and try again.";
    }
    if (action === "cancel" && error.status === 404) {
      return "This order couldn't be found. Refresh the order ID and try again.";
    }
    if (action === "reserve" && error.status === 409) {
      if (
        typeof error.detail === "object" &&
        error.detail !== null &&
        "items" in error.detail &&
        Array.isArray(error.detail.items)
      ) {
        const shortages = error.detail.items.flatMap((item) => {
          if (
            typeof item === "object" &&
            item !== null &&
            "sku" in item &&
            typeof item.sku === "string" &&
            "available" in item &&
            typeof item.available === "number" &&
            "requested" in item &&
            typeof item.requested === "number"
          ) {
            const name = inventoryBySku.get(item.sku)?.name ?? item.sku;
            return [`${name}: ${item.available} available, ${item.requested} requested`];
          }
          return [];
        });
        if (shortages.length) {
          return `Not enough stock to fill this order - ${shortages.join("; ")}. Adjust the quantities and try again.`;
        }
      }
      return "Some items no longer have enough stock. Availability has been refreshed - adjust the quantities and try again.";
    }
    if (action === "reserve" && error.status === 404) {
      return "An item in this draft is no longer in the catalog. Remove it or refresh inventory before trying again.";
    }
    if (error.status === 422) {
      return "Check the order details. Each item needs a valid SKU and a whole-number quantity greater than zero.";
    }
    if (error.status >= 500) {
      return "The service couldn't complete this request. Your changes weren't confirmed—please retry.";
    }
    return error.message || "The request couldn't be completed. Review the details and try again.";
  }
  if (error instanceof TypeError) {
    return "We couldn't reach the service. Check your connection and retry; your reservation draft is still here.";
  }
  return "Something unexpected happened. Please try again.";
}
