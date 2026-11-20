from sqlalchemy.dialects.postgresql import insert

from app.db import SessionLocal
from app.models import Inventory

SEED_INVENTORY = [
    {"sku": "LAMP-001", "name": "Arc Desk Lamp", "available": 8},
    {"sku": "MUG-002", "name": "Stoneware Mug", "available": 25},
    {"sku": "CHAIR-003", "name": "Oak Side Chair", "available": 3},
    {"sku": "BOOK-004", "name": "Field Notes Journal", "available": 12},
    {"sku": "LAST-UNIT", "name": "Limited Edition Print", "available": 1},
    {"sku": "SOLD-OUT", "name": "Retired Sample", "available": 0},
]


def seed() -> None:
    with SessionLocal.begin() as session:
        session.execute(
            insert(Inventory)
            .values(SEED_INVENTORY)
            .on_conflict_do_nothing(index_elements=[Inventory.sku])
        )
    print(f"Seeded {len(SEED_INVENTORY)} synthetic inventory SKUs (existing SKUs unchanged).")


if __name__ == "__main__":
    seed()
