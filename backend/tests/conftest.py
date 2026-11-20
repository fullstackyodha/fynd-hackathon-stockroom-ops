from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models import IdempotencyRecord, Inventory, Order, OrderItem


@pytest.fixture(scope="session", autouse=True)
def apply_schema_migrations() -> None:
    backend_root = Path(__file__).resolve().parents[1]
    alembic_config = Config(str(backend_root / "alembic.ini"))
    alembic_config.set_main_option("script_location", str(backend_root / "migrations"))
    command.upgrade(alembic_config, "head")


@pytest.fixture
def inventory_factory() -> Iterator[tuple[str, str]]:
    token = uuid4().hex[:12].upper()
    skus = (f"TEST-A-{token}", f"TEST-B-{token}")
    try:
        yield skus
    finally:
        with SessionLocal.begin() as session:
            order_ids = session.scalars(
                select(Order.id).join(OrderItem).where(OrderItem.sku.in_(skus))
            ).all()
            if order_ids:
                session.execute(
                    delete(IdempotencyRecord).where(IdempotencyRecord.order_id.in_(order_ids))
                )
                session.execute(delete(OrderItem).where(OrderItem.order_id.in_(order_ids)))
                session.execute(delete(Order).where(Order.id.in_(order_ids)))
            session.execute(delete(Inventory).where(Inventory.sku.in_(skus)))


@pytest.fixture
def add_inventory():
    def add(skus: tuple[str, str], quantities: tuple[int, int]) -> None:
        with SessionLocal.begin() as session:
            session.add_all(
                [
                    Inventory(sku=skus[0], name="Test item A", available=quantities[0]),
                    Inventory(sku=skus[1], name="Test item B", available=quantities[1]),
                ]
            )

    return add
