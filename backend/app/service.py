import hashlib
import json
from uuid import UUID

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.errors import (
    DuplicateSkuLines,
    IdempotencyConflict,
    InsufficientInventory,
    OrderNotFound,
    SkuNotFound,
)
from app.models import Inventory, Order, OrderItem
from app.repositories import InventoryRepository, OrderRepository
from app.schemas import CreateOrderRequest, InventoryResponse, OrderResponse


def canonical_payload(request: CreateOrderRequest) -> tuple[list[tuple[str, int]], str]:
    items = sorted((line.sku, line.quantity) for line in request.items)
    if len({sku for sku, _ in items}) != len(items):
        raise DuplicateSkuLines()
    serialized = json.dumps(items, separators=(",", ":"), ensure_ascii=True)
    return items, hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def serialize_order(order: Order) -> OrderResponse:
    return OrderResponse(
        id=order.id,
        status=order.status,
        created_at=order.created_at,
        cancelled_at=order.cancelled_at,
        items=[
            {"sku": line.sku, "name": line.name, "quantity": line.quantity} for line in order.items
        ],
    )


def serialize_inventory(inventory: Inventory) -> InventoryResponse:
    return InventoryResponse(
        sku=inventory.sku,
        name=inventory.name,
        available=inventory.available,
        updated_at=inventory.updated_at,
    )


class OrderService:
    def __init__(
        self,
        session: Session,
        orders: OrderRepository | None = None,
        inventory: InventoryRepository | None = None,
    ) -> None:
        self._session = session
        self._orders = orders or OrderRepository(session)
        self._inventory = inventory or InventoryRepository(session)

    def create(
        self, request: CreateOrderRequest, idempotency_key: str
    ) -> tuple[OrderResponse, bool]:
        items, payload_hash = canonical_payload(request)
        replayed = False

        with self._session.begin():
            claim = self._orders.claim_idempotency_key(idempotency_key, payload_hash)

            if claim is None:
                record = self._orders.get_idempotency_record(idempotency_key)
                if record is None:
                    raise RuntimeError("Idempotency record disappeared after a conflicting insert.")
                if record.payload_hash != payload_hash:
                    raise IdempotencyConflict()
                if record.order_id is None:
                    raise RuntimeError("Committed idempotency record has no associated order.")
                order = self._orders.get(record.order_id)
                if order is None:
                    raise RuntimeError("Idempotency record references a missing order.")
                replayed = True
            else:
                skus = [sku for sku, _ in items]
                locked_inventory = self._inventory.lock_many(skus)
                stock_by_sku = {row.sku: row.available for row in locked_inventory}
                name_by_sku = {row.sku: row.name for row in locked_inventory}
                missing = [sku for sku in skus if sku not in stock_by_sku]
                if missing:
                    raise SkuNotFound(missing)

                unavailable = [
                    {"sku": sku, "requested": quantity, "available": stock_by_sku[sku]}
                    for sku, quantity in items
                    if stock_by_sku[sku] < quantity
                ]
                if unavailable:
                    raise InsufficientInventory(unavailable)

                self._inventory.change_available(dict(items), release=False)
                order = Order(
                    items=[
                        OrderItem(sku=sku, name=name_by_sku[sku], quantity=quantity)
                        for sku, quantity in items
                    ]
                )
                self._orders.add(order)
                self._orders.bind_idempotency_key(idempotency_key, order.id)
                self._session.flush()

            response = serialize_order(order)

        return response, replayed

    def get(self, order_id: UUID) -> OrderResponse:
        with self._session.begin():
            order = self._orders.get(order_id)
            if order is None:
                raise OrderNotFound()
            return serialize_order(order)

    def cancel(self, order_id: UUID) -> OrderResponse:
        with self._session.begin():
            order = self._orders.get(order_id, lock=True)
            if order is None:
                raise OrderNotFound()
            if order.status == "active":
                quantities: dict[str, int] = {}
                for line in order.items:
                    quantities[line.sku] = quantities.get(line.sku, 0) + line.quantity
                self._inventory.change_available(quantities, release=True)
                order.status = "cancelled"
                order.cancelled_at = func.now()
                self._session.flush()
                self._session.refresh(order, attribute_names=["cancelled_at"])
            return serialize_order(order)


class InventoryService:
    def __init__(self, session: Session, inventory: InventoryRepository | None = None) -> None:
        self._session = session
        self._inventory = inventory or InventoryRepository(session)

    def list_all(self) -> list[InventoryResponse]:
        with self._session.begin():
            return [serialize_inventory(row) for row in self._inventory.list_all()]

    def get(self, sku: str) -> InventoryResponse:
        with self._session.begin():
            inventory = self._inventory.get(sku)
            if inventory is None:
                raise SkuNotFound(sku)
            return serialize_inventory(inventory)
