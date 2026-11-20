from typing import Any


class ApplicationError(Exception):
    status_code = 500

    def __init__(self, detail: Any) -> None:
        super().__init__(str(detail))
        self.detail = detail


class DuplicateSkuLines(ApplicationError):
    status_code = 422

    def __init__(self) -> None:
        super().__init__("Each SKU must appear at most once; combine duplicate lines.")


class OrderNotFound(ApplicationError):
    status_code = 404

    def __init__(self) -> None:
        super().__init__("Order not found.")


class SkuNotFound(ApplicationError):
    status_code = 404

    def __init__(self, skus: str | list[str]) -> None:
        missing = [skus] if isinstance(skus, str) else skus
        super().__init__({"message": "Unknown SKU.", "skus": missing})


class InsufficientInventory(ApplicationError):
    status_code = 409

    def __init__(self, items: list[dict[str, int | str]]) -> None:
        super().__init__({"message": "Insufficient inventory.", "items": items})


class IdempotencyConflict(ApplicationError):
    status_code = 409

    def __init__(self) -> None:
        super().__init__("Idempotency-Key was already used with a different payload.")
