from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Response, status

from app.api.dependencies import get_inventory_service, get_order_service
from app.schemas import CreateOrderRequest, InventoryResponse, OrderResponse
from app.service import InventoryService, OrderService

router = APIRouter(prefix="/api/v1")
OrderServiceDependency = Annotated[OrderService, Depends(get_order_service)]
InventoryServiceDependency = Annotated[InventoryService, Depends(get_inventory_service)]


@router.post(
    "/orders",
    response_model=OrderResponse,
    status_code=status.HTTP_201_CREATED,
    responses={200: {"model": OrderResponse, "description": "Idempotent replay"}},
)
def post_order(
    body: CreateOrderRequest,
    response: Response,
    service: OrderServiceDependency,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)],
) -> OrderResponse:
    order, replayed = service.create(body, idempotency_key)
    if replayed:
        response.status_code = status.HTTP_200_OK
        response.headers["Idempotency-Replayed"] = "true"
    return order


@router.get("/orders/{order_id}", response_model=OrderResponse)
def read_order(order_id: UUID, service: OrderServiceDependency) -> OrderResponse:
    return service.get(order_id)


@router.delete("/orders/{order_id}", response_model=OrderResponse)
def delete_order(order_id: UUID, service: OrderServiceDependency) -> OrderResponse:
    return service.cancel(order_id)


@router.get("/inventory", response_model=list[InventoryResponse])
def list_inventory(service: InventoryServiceDependency) -> list[InventoryResponse]:
    return service.list_all()


@router.get("/inventory/{sku}", response_model=InventoryResponse)
def read_inventory(sku: str, service: InventoryServiceDependency) -> InventoryResponse:
    return service.get(sku)
