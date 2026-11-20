from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class OrderLineRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sku: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    quantity: int = Field(gt=0, le=100_000)


class CreateOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[OrderLineRequest] = Field(min_length=1, max_length=100)


class OrderLineResponse(BaseModel):
    sku: str
    name: str
    quantity: int


class OrderResponse(BaseModel):
    id: UUID
    status: Literal["active", "cancelled"]
    created_at: datetime
    cancelled_at: datetime | None
    items: list[OrderLineResponse]


class InventoryResponse(BaseModel):
    sku: str
    name: str
    available: int
    updated_at: datetime
