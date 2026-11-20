import logging
from uuid import uuid4

from fastapi.testclient import TestClient

from app.api.dependencies import get_order_service
from app.main import app
from app.service import OrderService


def test_order_inventory_and_cancellation_http_contract(inventory_factory, add_inventory):
    skus = inventory_factory
    add_inventory(skus, (4, 0))
    key = f"http-{uuid4()}"
    payload = {"items": [{"sku": skus[0], "quantity": 2}]}

    with TestClient(app) as client:
        created = client.post(
            "/api/v1/orders",
            json=payload,
            headers={"Idempotency-Key": key},
        )
        replay = client.post(
            "/api/v1/orders",
            json=payload,
            headers={"Idempotency-Key": key},
        )
        order_id = created.json()["id"]

        assert created.status_code == 201
        assert created.json()["items"][0]["name"] == "Test item A"
        assert replay.status_code == 200
        assert replay.headers["Idempotency-Replayed"] == "true"
        assert replay.json()["id"] == order_id
        assert client.get(f"/api/v1/orders/{order_id}").status_code == 200
        assert client.get(f"/api/v1/inventory/{skus[0]}").json()["available"] == 2

        cancelled = client.delete(f"/api/v1/orders/{order_id}").json()
        repeated_cancel = client.delete(f"/api/v1/orders/{order_id}").json()
        assert cancelled["status"] == repeated_cancel["status"] == "cancelled"
        assert cancelled["cancelled_at"] is not None
        assert repeated_cancel["cancelled_at"] == cancelled["cancelled_at"]
        assert client.get(f"/api/v1/inventory/{skus[0]}").json()["available"] == 4
        assert client.get("/api/v1/inventory").status_code == 200
        assert client.get("/api/v1/orders/00000000-0000-0000-0000-000000000000").status_code == 404
        assert client.get("/health/live").json() == {"status": "ok"}
        assert client.get("/health/ready").json() == {"status": "ready"}
        assert created.headers["X-Request-ID"]


def test_missing_sku_uses_stable_error_contract_and_request_id():
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/orders",
            json={"items": [{"sku": "MISSING-SKU", "quantity": 1}]},
            headers={"Idempotency-Key": f"missing-{uuid4()}"},
        )

    assert response.status_code == 404
    assert response.json()["detail"] == {
        "message": "Unknown SKU.",
        "skus": ["MISSING-SKU"],
    }
    assert response.headers["X-Request-ID"]


def test_unexpected_error_is_generic_and_correlated_in_logs(monkeypatch, caplog):
    def fail_service() -> OrderService:
        raise RuntimeError("internal implementation detail")

    monkeypatch.setitem(app.dependency_overrides, get_order_service, fail_service)
    with (
        TestClient(app, raise_server_exceptions=False) as client,
        caplog.at_level(logging.ERROR),
    ):
        response = client.post(
            "/api/v1/orders",
            json={"items": [{"sku": "LAMP-001", "quantity": 1}]},
            headers={"Idempotency-Key": f"unexpected-{uuid4()}"},
        )

    assert response.status_code == 500
    assert response.json() == {"detail": "An unexpected server error occurred."}
    request_id = response.headers["X-Request-ID"]
    assert request_id in caplog.text
