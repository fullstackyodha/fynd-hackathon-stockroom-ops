from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

from app.db import get_session
from app.service import InventoryService, OrderService

SessionDependency = Annotated[Session, Depends(get_session)]


def get_order_service(session: SessionDependency) -> OrderService:
    return OrderService(session)


def get_inventory_service(session: SessionDependency) -> InventoryService:
    return InventoryService(session)
