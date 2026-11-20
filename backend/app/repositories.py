from collections.abc import Mapping, Sequence
from uuid import UUID

from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, selectinload

from app.models import IdempotencyRecord, Inventory, Order


class InventoryRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def list_all(self) -> list[Inventory]:
        return list(self._session.scalars(select(Inventory).order_by(Inventory.sku)).all())

    def get(self, sku: str) -> Inventory | None:
        return self._session.get(Inventory, sku)

    def lock_many(self, skus: Sequence[str]) -> list[Inventory]:
        return list(
            self._session.scalars(
                select(Inventory)
                .where(Inventory.sku.in_(skus))
                .order_by(Inventory.sku)
                .with_for_update()
            ).all()
        )

    def change_available(self, quantities: Mapping[str, int], *, release: bool) -> None:
        if not quantities:
            return

        rows = sorted(quantities.items())
        values_sql = ", ".join(f"(:sku_{index}, :quantity_{index})" for index in range(len(rows)))
        parameters = {
            parameter: value
            for index, (sku, quantity) in enumerate(rows)
            for parameter, value in (
                (f"sku_{index}", sku),
                (f"quantity_{index}", quantity),
            )
        }
        operation = "+" if release else "-"
        self._session.execute(
            text(
                "UPDATE inventory AS i "
                f"SET available = i.available {operation} requested.quantity, updated_at = now() "
                f"FROM (VALUES {values_sql}) AS requested(sku, quantity) "
                "WHERE i.sku = requested.sku"
            ),
            parameters,
        )


class OrderRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def claim_idempotency_key(self, key: str, payload_hash: str) -> str | None:
        return self._session.execute(
            insert(IdempotencyRecord)
            .values(key=key, payload_hash=payload_hash)
            .on_conflict_do_nothing(index_elements=[IdempotencyRecord.key])
            .returning(IdempotencyRecord.key)
        ).scalar_one_or_none()

    def get_idempotency_record(self, key: str) -> IdempotencyRecord | None:
        return self._session.scalar(
            select(IdempotencyRecord).where(IdempotencyRecord.key == key).with_for_update()
        )

    def get(self, order_id: UUID, *, lock: bool = False) -> Order | None:
        statement = select(Order).options(selectinload(Order.items)).where(Order.id == order_id)
        if lock:
            statement = statement.with_for_update()
        return self._session.scalar(statement)

    def add(self, order: Order) -> None:
        self._session.add(order)
        self._session.flush()

    def bind_idempotency_key(self, key: str, order_id: UUID) -> None:
        self._session.execute(
            update(IdempotencyRecord).where(IdempotencyRecord.key == key).values(order_id=order_id)
        )
