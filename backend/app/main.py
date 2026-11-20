import logging
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from starlette.middleware.base import RequestResponseEndpoint

from app.api.routes import router
from app.config import settings
from app.db import engine
from app.errors import ApplicationError

logger = logging.getLogger(__name__)

app = FastAPI(
    title="Order & Inventory Reservation API",
    version="1.0.0",
    description="Atomic inventory reservations with durable idempotency keys.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "Idempotency-Key"],
    expose_headers=["Idempotency-Replayed", "X-Request-ID"],
)
app.include_router(router)


@app.middleware("http")
async def add_request_id(
    request: Request,
    call_next: RequestResponseEndpoint,
) -> Response:
    request_id = uuid4().hex
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


@app.exception_handler(ApplicationError)
async def handle_application_error(request: Request, error: ApplicationError) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={"detail": error.detail},
        headers={"X-Request-ID": request.state.request_id},
    )


@app.exception_handler(SQLAlchemyError)
async def handle_database_error(request: Request, error: SQLAlchemyError) -> JSONResponse:
    request_id = request.state.request_id
    logger.exception("Unexpected database error request_id=%s", request_id)
    return JSONResponse(
        status_code=500,
        content={"detail": "An unexpected server error occurred."},
        headers={"X-Request-ID": request_id},
    )


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, error: Exception) -> JSONResponse:
    request_id = request.state.request_id
    logger.exception("Unhandled server error request_id=%s", request_id)
    return JSONResponse(
        status_code=500,
        content={"detail": "An unexpected server error occurred."},
        headers={"X-Request-ID": request_id},
    )


@app.get("/health/live", tags=["operations"])
def liveness() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready", tags=["operations"])
@app.get("/healthz", tags=["operations"], include_in_schema=False)
def readiness(request: Request) -> dict[str, str]:
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("SELECT 1")
    except SQLAlchemyError as error:
        logger.exception(
            "Database readiness probe failed request_id=%s",
            request.state.request_id,
        )
        raise HTTPException(status_code=503, detail="Database is unavailable.") from error
    return {"status": "ready"}
