from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import func, select

from app.db import SessionLocal
from app.errors import ApplicationError, InsufficientInventory
from app.models import IdempotencyRecord, Inventory, Order, OrderItem
from app.schemas import CreateOrderRequest, OrderLineRequest
from app.service import OrderService


def request_for(sku: str, quantity: int = 1) -> CreateOrderRequest:
    return CreateOrderRequest(items=[OrderLineRequest(sku=sku, quantity=quantity)])


def submit(payload: CreateOrderRequest, key: str, gate: Barrier | None = None):
    if gate:
        gate.wait(timeout=10)
    with SessionLocal() as session:
        return OrderService(session).create(payload, key)


def read_stock(sku: str) -> int:
    with SessionLocal() as session:
        return session.get(Inventory, sku).available


def order_counts(sku: str) -> tuple[int, int]:
    with SessionLocal() as session:
        orders = session.scalar(
            select(func.count(func.distinct(Order.id)))
            .join(OrderItem, OrderItem.order_id == Order.id)
            .where(OrderItem.sku == sku)
        )
        reservations = session.scalar(
            select(func.count(IdempotencyRecord.key))
            .join(Order, IdempotencyRecord.order_id == Order.id)
            .join(OrderItem, OrderItem.order_id == Order.id)
            .where(OrderItem.sku == sku)
        )
        return orders, reservations


def test_distinct_requests_competing_for_last_unit_are_serialized(inventory_factory, add_inventory):
    skus = inventory_factory
    add_inventory(skus, (1, 0))
    gate = Barrier(2)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(submit, request_for(skus[0]), f"buyer-{index}-{uuid4()}", gate)
            for index in range(2)
        ]
        results = []
        failures = []
        for future in futures:
            try:
                results.append(future.result(timeout=20))
            except ApplicationError as error:
                failures.append(error)

    assert len(results) == 1
    assert len(failures) == 1
    assert failures[0].status_code == 409
    assert read_stock(skus[0]) == 0
    assert order_counts(skus[0]) == (1, 1)


def test_overlapping_same_key_retry_returns_original_order(inventory_factory, add_inventory):
    skus = inventory_factory
    add_inventory(skus, (5, 0))
    key = f"retry-{uuid4()}"
    payload = request_for(skus[0], 2)
    gate = Barrier(2)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(submit, payload, key, gate) for _ in range(2)]
        results = [future.result(timeout=20) for future in futures]

    assert results[0][0].id == results[1][0].id
    assert sorted(result[1] for result in results) == [False, True]
    assert read_stock(skus[0]) == 3
    assert order_counts(skus[0]) == (1, 1)


def test_failed_multi_item_reservation_has_no_partial_writes(inventory_factory, add_inventory):
    skus = inventory_factory
    add_inventory(skus, (3, 0))
    payload = CreateOrderRequest(
        items=[
            OrderLineRequest(sku=skus[0], quantity=2),
            OrderLineRequest(sku=skus[1], quantity=1),
        ]
    )
    key = f"atomic-{uuid4()}"

    with SessionLocal() as session, pytest.raises(InsufficientInventory) as error:
        OrderService(session).create(payload, key)

    assert error.value.status_code == 409
    assert read_stock(skus[0]) == 3
    assert read_stock(skus[1]) == 0
    assert order_counts(skus[0]) == (0, 0)
    with SessionLocal() as session:
        assert session.get(IdempotencyRecord, key) is None


def test_reusing_key_with_different_payload_conflicts_without_mutation(
    inventory_factory, add_inventory
):
    skus = inventory_factory
    add_inventory(skus, (5, 5))
    key = f"payload-{uuid4()}"
    with SessionLocal() as session:
        original, _ = OrderService(session).create(request_for(skus[0]), key)
    with SessionLocal() as session, pytest.raises(ApplicationError) as error:
        OrderService(session).create(request_for(skus[1]), key)

    assert error.value.status_code == 409
    assert read_stock(skus[0]) == 4
    assert read_stock(skus[1]) == 5
    assert order_counts(skus[0]) == (1, 1)
    with SessionLocal() as session:
        assert OrderService(session).get(original.id).id == original.id


def test_cancellation_releases_exact_quantities_once(inventory_factory, add_inventory):
    skus = inventory_factory
    add_inventory(skus, (8, 8))
    key = f"cancel-{uuid4()}"
    payload = CreateOrderRequest(
        items=[
            OrderLineRequest(sku=skus[0], quantity=2),
            OrderLineRequest(sku=skus[1], quantity=3),
        ]
    )
    with SessionLocal() as session:
        created, _ = OrderService(session).create(payload, key)
    assert (read_stock(skus[0]), read_stock(skus[1])) == (6, 5)

    with SessionLocal() as session:
        first_cancel = OrderService(session).cancel(created.id)
    with SessionLocal() as session:
        repeated_cancel = OrderService(session).cancel(created.id)

    assert first_cancel.status == repeated_cancel.status == "cancelled"
    assert first_cancel.cancelled_at is not None
    assert repeated_cancel.cancelled_at == first_cancel.cancelled_at
    assert (read_stock(skus[0]), read_stock(skus[1])) == (8, 8)
    assert order_counts(skus[0]) == (1, 1)
