# Stockroom — Order & Inventory Reservation Service

A small, runnable full-stack order reservation service built with FastAPI, PostgreSQL, SQLAlchemy, and React. The operator page supports direct order links and lookup, multi-item reservations, safe cancellation, and live stock with clear recovery guidance.

- [Architecture, schema, state machines, API, and scaling decisions](./docs/ARCHITECTURE.md)
- [Hackathon product pitch and demo script](./docs/PRODUCT_PITCH.md)

## Run locally (Windows PowerShell)

### Recommended: full stack with Docker Compose

Prerequisite: Docker Desktop is installed and running. Run these commands from the repository root:

```powershell
Set-Location C:\Users\harsh\Desktop\Hackathon
docker info
docker compose up --build -d
docker compose ps
```

Wait until `db` is healthy and `api` is healthy; the frontend should show as running. On first startup, Compose creates PostgreSQL, applies Alembic migrations, seeds synthetic products without overwriting existing stock, then starts the API and UI.

Open:

- Operator UI: `http://localhost:5173`
- API health: `http://localhost:8000/health/ready`
- Interactive API docs: `http://localhost:8000/docs`

Verify the API from PowerShell:

```powershell
Invoke-RestMethod http://localhost:8000/health/live
Invoke-RestMethod http://localhost:8000/health/ready
Invoke-RestMethod http://localhost:8000/api/v1/inventory
```

Useful lifecycle commands:

```powershell
docker compose logs -f api       # follow API startup/migration logs; Ctrl+C stops following
docker compose logs -f db        # inspect PostgreSQL startup
docker compose down              # stop containers; keep the postgres_data volume
docker compose up -d             # restart without rebuilding
```

PostgreSQL is published on `localhost:5434`; its data persists in the `postgres_data` volume. Use `docker compose down -v` only when intentionally deleting the local database and all demo data.

### Local development with hot reload

Use this when you want the API and frontend processes on the host while PostgreSQL stays in Docker. Open three PowerShell terminals.

**Terminal 1 — database:**

```powershell
Set-Location C:\Users\harsh\Desktop\Hackathon
docker compose up -d db
docker compose ps
```

Wait for the database health status before starting the API.

**Terminal 2 — backend:**

```powershell
Set-Location C:\Users\harsh\Desktop\Hackathon\backend
py -m pip install uv==0.11.7
uv sync --locked --extra dev
$env:DATABASE_URL = "postgresql+psycopg://reservations:reservations@localhost:5434/reservations"
uv run --locked alembic upgrade head
uv run --locked python -m app.seed
uv run --locked uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Keep this terminal open. API docs are at `http://localhost:8000/docs`.

**Terminal 3 — frontend:**

```powershell
Set-Location C:\Users\harsh\Desktop\Hackathon\frontend
npm ci
$env:VITE_API_BASE_URL = "http://localhost:8000"
npm run dev
```

Open `http://localhost:5173`. Stop the host API and Vite with `Ctrl+C` in their terminals; stop the database with `docker compose down` from the project root. If using a non-default API URL, set `VITE_API_BASE_URL` before starting Vite and add the UI origin to the API's `CORS_ORIGINS`.

### Startup troubleshooting

- **Docker engine unavailable:** open Docker Desktop, wait for the engine to finish starting, then confirm `docker info` succeeds.
- **Port already allocated:** Compose needs host ports `5434` (PostgreSQL), `8000` (API), and `5173` (UI). Stop the conflicting process or change the corresponding left-hand port in `docker-compose.yml`.
- **API stays unhealthy:** inspect `docker compose logs api` and `docker compose logs db`. The API waits for PostgreSQL, applies migrations, and seeds data before serving requests.
- **UI loads but API calls fail:** check `/health/ready`, confirm `VITE_API_BASE_URL` is `http://localhost:8000`, and verify `CORS_ORIGINS` includes the UI origin.

The operator UI keeps the order ID in a shareable `?order=<uuid>` URL, supports multiple distinct SKUs per reservation, explains stock conflicts in product terms, and asks for confirmation before cancellation. In-progress draft lines and their idempotency key are kept in the current browser tab's session storage, so a refresh or an uncertain network response can be retried without creating a duplicate. A successful response clears that pending draft/key. The server remains the source of truth for stock, so displayed availability is guidance rather than a guarantee.

## API reference

All endpoints are under `/api/v1`. Responses include `X-Request-ID` for support/log correlation. JSON errors use FastAPI's standard `{"detail": ...}` shape. UUID path values are validated; unknown orders/SKUs return `404`.

### Reserve all requested items

`POST /api/v1/orders` requires an `Idempotency-Key` header (1–128 characters).

```http
POST /api/v1/orders
Content-Type: application/json
Idempotency-Key: checkout-7b6e4c

{"items":[{"sku":"LAMP-001","quantity":2},{"sku":"MUG-002","quantity":1}]}
```

First success returns `201 Created` and the persisted order representation. A retry with the same key and equivalent payload returns that order with `200 OK` and `Idempotency-Replayed: true`. Reusing the key with a different payload returns `409 Conflict`. An unknown SKU returns `404`; insufficient stock returns `409` with per-SKU requested/available counts. No failed reservation leaves a row or changes stock.

### Retrieve, cancel, inspect

```http
GET    /api/v1/orders/{order_id}
DELETE /api/v1/orders/{order_id}
GET    /api/v1/inventory
GET    /api/v1/inventory/{sku}
GET    /health/live
GET    /health/ready
```

`DELETE` cancels an active order and returns its representation. Repeated deletes return the already-cancelled representation and do not release inventory again. Inventory reads return current available units, ordered by SKU for the collection endpoint.

## Concurrency and data integrity

- **One transaction is the unit of work.** A create request claims its idempotency key, locks the referenced inventory rows in SKU order, verifies every requested quantity, updates all stock in one set-based `UPDATE ... FROM (VALUES ...)`, writes the order and all lines, and associates the key with the order. The transaction commits all of it or none of it. A missing SKU, shortfall, or later database error rolls back the claim and every stock/order write.
- **Database invariants are not just application checks.** `inventory.available >= 0`, positive line quantities, SKU/order foreign keys, and unique `(order_id, sku)` lines are constrained in PostgreSQL. The stock update happens only after rows are locked and availability is checked inside the same transaction.
- **Competing buyers serialize at the stock row.** The deterministic SKU ordering reduces deadlock risk for overlapping multi-SKU orders. Row locks allow unrelated SKUs to proceed concurrently; PostgreSQL's default `READ COMMITTED` isolation is sufficient for these locked-row invariants.
- **Idempotency survives process restarts.** A primary key on `idempotency_records.key` is the arbitration point. `INSERT ... ON CONFLICT DO NOTHING` blocks behind an in-flight identical key; after that transaction commits, the retry reads and returns the original order. Payloads are canonically sorted and SHA-256 hashed. A key, hash, and order association are committed atomically, so a failed reservation does not consume the key.
- **Cancellation is an exact-once state transition.** It locks the order row, returns immediately if already cancelled, otherwise adds back the persisted line quantities and changes order status in the same commit. Competing/repeated cancellation requests serialize on that order row.
- **Query and index choices.** Inventory's primary key supports SKU lookups and row locks. Orders use a UUID primary key plus a created-time index; order lines have a unique order/SKU index and an SKU index; idempotency keys are primary keys. Reservation and release use one parameterized bulk update rather than one query per line. Request payload size is capped at 100 distinct SKUs. SQLAlchemy uses a bounded connection pool with pre-ping.

## Reproducible concurrency tests

Tests use the same PostgreSQL transaction and locking code as the API; no SQLite substitute is used. Point `DATABASE_URL` at a dedicated, disposable test database (the default local Compose database is okay if you are not running other tests against it):

```powershell
Set-Location C:\Users\harsh\Desktop\Hackathon\backend
$env:DATABASE_URL = "postgresql+psycopg://reservations:reservations@localhost:5434/reservations"
uv sync --locked --extra dev
uv run --locked pytest -vv
```

The test fixtures create unique synthetic SKU names, and remove only the records they created. `test_distinct_requests_competing_for_last_unit_are_serialized` releases two worker threads through a barrier, then checks one success, one `409`, one order/key, and zero remaining stock. Other tests overlap two same-key requests and check the same order ID / single decrement, prove a failed two-SKU request leaves both stock rows and order/key records unchanged, verify a payload mismatch, and call cancellation twice to assert an exact one-time release.

Frontend tests and type/build verification:

```powershell
Set-Location C:\Users\harsh\Desktop\Hackathon\frontend
npm ci
npm test
npm run build
```

## Implementation decisions and production follow-ups

- **No Temporal workflow in the reservation path.** Reserving stock and writing its order are a short, synchronous ACID database operation. A workflow engine cannot replace that transaction and would add a second consistency boundary. Temporal becomes useful after commit for long-running fulfillment, payment orchestration, delayed expiry, or compensating actions. Those should be emitted from a transactional outbox with an idempotent worker/workflow; never hold inventory locks while waiting on remote services.
- Alembic migrations are the schema source of truth. The API and seed command do not create or alter tables at runtime.
- Add authentication/authorization, operator audit events, rate limits, structured logs, and metrics/traces. The API already returns request IDs and correlates unexpected-failure logs; do not log raw idempotency keys or customer data.
- Introduce idempotency-record retention policy only after the retry window and order lookup requirements are defined. Retain tombstones or unique order keys for at least the maximum client retry interval.
- For higher throughput, measure lock waits and hot SKUs, set transaction/statement timeouts, use bounded retries for PostgreSQL deadlock/serialization errors, and add pool/DB capacity controls. Consider partitioning or a separate inventory ledger only when observed scale warrants it; the current locked balance rows are the authoritative simple design.
- Define reservation expiry / payment semantics explicitly. If expiry is required, use a durable scheduled worker and make expiry compete through the same order-row lock and transactional release path as cancellation.
- `orders.created_at` is indexed for the natural next operator feature, a paginated, time-bounded order list. This challenge UI deliberately focuses on lookup by order ID and stock, keeping its read patterns bounded.

## Evidence

The operator interface is the running page at `http://localhost:5173`; it includes the live inventory table, order lookup, reservation form, and cancellation action. For a concise concurrency demonstration, run:

```powershell
python -m pytest -vv -k distinct_requests_competing_for_last_unit
```

The test asserts the final order and idempotency records as well as inventory after both concurrent attempts complete.
