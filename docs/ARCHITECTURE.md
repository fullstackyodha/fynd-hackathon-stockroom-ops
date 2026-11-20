# Stockroom | Architecture and engineering brief

Stockroom is a single-merchant order reservation service with an operator-facing web UI. The primary invariant is stronger than “check stock, then decrement”: an order and every one of its stock changes commit together, or none do.

- [Product pitch](./PRODUCT_PITCH.md) — seminar narrative and demo plan.
- [Project README](../README.md) — local setup and test commands.

## 1. Scope and assumptions

### In scope

- Create and retrieve an order.
- Reserve several distinct SKUs atomically.
- Inspect current sellable quantity.
- Cancel an active order and release its exact persisted quantities once.
- Make retried `POST` requests safe through a durable idempotency key.
- Let an operator find an order, understand a stock conflict, and recover from common errors.

### Explicit assumptions

- A stock row is the authoritative sellable balance for one SKU.
- The challenge models one merchant. SKU and idempotency keys are not tenant-scoped yet.
- Orders represent reservations, not payment authorization or fulfillment.
- A reservation has no automatic expiry. Cancellation is an explicit operator action.
- Available stock can change immediately after an inventory read. The reservation transaction is the final authority.
- A cancelled order is retained as history; cancellation does not delete an order or its idempotency record.

## 2. System context

```mermaid
flowchart LR
    Operator["Merchant operator"]
    UI["React operator UI"]
    API["FastAPI REST API"]
    DB[("PostgreSQL")]
    Migrations["Alembic migrations"]

    Operator --> UI
    UI -->|"JSON over HTTP"| API
    API -->|"single ACID transaction"| DB
    Migrations -->|"versioned DDL"| DB
```

The UI does not calculate authoritative availability and the API does not depend on frontend state. The browser sends the requested lines and an idempotency key; PostgreSQL decides whether all lines can be reserved.

## 3. Backend structure and ownership

```text
backend/
  app/
    api/
      dependencies.py   Request-scoped service construction
      routes.py         HTTP/controller mapping and response status/headers
    config.py           Environment-backed runtime configuration
    db.py               SQLAlchemy engine, bounded pool, request-scoped sessions
    errors.py           Typed application errors and stable HTTP mappings
    main.py             App metadata, middleware, logging and health probes
    models.py           Persistence schema and ORM relationships
    repositories.py     Focused inventory/order persistence operations
    schemas.py          Request validation and response contracts
    service.py          Reservation, read, and cancellation use cases
    seed.py             Idempotent synthetic inventory seed command
  migrations/
    env.py
    versions/           Forward-only, reviewed schema revisions
  tests/                PostgreSQL integration and concurrency tests
```

The route layer translates HTTP to typed service inputs and outputs. The service layer owns business invariants and transaction boundaries. SQLAlchemy models describe persistence; Pydantic schemas define the external contract. Alembic, rather than application startup or the seed script, owns schema changes.

FastAPI handlers are synchronous `def` handlers because they use synchronous SQLAlchemy/psycopg calls. FastAPI runs them in its worker threadpool; the request never blocks the event loop with synchronous database I/O.

### Backend design principles and pattern choices

The backend uses an MVC-style separation adapted to an API:

| MVC responsibility | Implementation | Why it lives there |
|---|---|---|
| Model | `models.py` plus `schemas.py` | ORM models describe persisted state; Pydantic schemas validate and shape the external representation. Separating them prevents storage details from becoming the API contract. |
| Controller | `api/routes.py` | Routes map HTTP inputs, call a use case, and choose HTTP-only details such as replay status and headers. They do not execute reservation SQL. |
| View | React operator UI and JSON response schemas | The operator UI presents API data; the API's response models are the representation for non-browser clients. |
| Application/service | `service.py` | Owns business workflows, transaction boundaries, and invariant decisions independently from HTTP. |
| Persistence/repository | `repositories.py` | Encapsulates SQLAlchemy queries, row locking, and bulk stock updates so that query mechanics do not leak into controllers. |

This is MVC in spirit rather than a framework-mandated class hierarchy. The service layer and repository pattern are used because reservation requires multiple coordinated writes and the persistence queries have meaningful behavior (locking and set-based updates). We intentionally do not add a generic base repository, ORM wrapper, or abstract factory: there is one PostgreSQL adapter, and those abstractions would add indirection without a second implementation to justify them.

The main SOLID applications are:

- **Single responsibility:** `post_order` handles HTTP; `OrderService.create` handles the reservation use case; `OrderRepository` claims/loads order state; `InventoryRepository` locks and changes balances. A change to the API envelope does not require rewriting SQL.
- **Dependency inversion at the boundary:** FastAPI's dependency providers construct a service for each request and pass in the request-scoped SQLAlchemy session. The service does not import FastAPI or raise HTTP exceptions; typed application errors are mapped to HTTP by `main.py`.
- **Interface segregation and composition:** order and inventory persistence are separate, focused collaborators. The service constructor accepts repository collaborators for substitution in focused tests if that becomes useful; no all-purpose database service is exposed to routes.
- **Open/closed through stable seams:** new HTTP response behavior belongs in the controller/exception mapping; a second persistence adapter can be introduced behind the repository collaboration without changing the route contract. We have not added speculative plugin abstractions in advance of such a need.
- **Liskov substitution:** no inheritance hierarchy is needed for the current domain. Avoiding artificial base classes keeps contracts explicit rather than claiming substitutability that is not used.

For example, cancellation is one use case in `OrderService.cancel`: it locks the order, reads its persisted quantities, asks the inventory repository to release them, and transitions the state in the same SQLAlchemy transaction. The route only calls `service.cancel(order_id)`. This keeps the exact-once business rule available to any future API or worker without duplicating it in each transport.

### Session, transaction, errors, and logs

- `get_session` opens one SQLAlchemy `Session` per request and always rolls back any still-open transaction before closing. A service explicitly scopes each use case with `session.begin()`; successful writes commit once, and any raised error rolls the full transaction back. A read's implicit transaction is also ended at request teardown.
- The session is passed to both repositories for that request; it is never shared across requests or concurrent threads. It is not stored globally, cached in a service singleton, or passed to background work.
- Expected business failures use typed application exceptions (`InsufficientInventory`, `IdempotencyConflict`, `OrderNotFound`). The HTTP exception handler translates these into the established status codes and `{"detail": ...}` contract. Unexpected database/application failures return a generic `500`; internal exception details are logged, not returned to callers.
- Each response includes an opaque `X-Request-ID`. Unexpected failures log the request ID with the exception stack so operators can correlate a client report with server logs. SQLAlchemy parameter rendering is disabled on the engine, and request bodies, idempotency keys, and credentials are not logged.
- Expected `404`/`409` outcomes are not error-log events; they are normal business results. Database readiness failures are logged and returned as `503` by the readiness probe.

## 4. Data model

```mermaid
erDiagram
    INVENTORY ||--o{ ORDER_ITEMS : "SKU referenced by"
    ORDERS ||--|{ ORDER_ITEMS : contains
    ORDERS ||--o| IDEMPOTENCY_RECORDS : created_by

    INVENTORY {
        varchar sku PK
        varchar name
        integer available "CHECK >= 0"
        timestamptz updated_at
    }
    ORDERS {
        uuid id PK
        varchar status "active | cancelled"
        timestamptz created_at
        timestamptz cancelled_at "null iff active"
    }
    ORDER_ITEMS {
        integer id PK
        uuid order_id FK
        varchar sku FK
        varchar name "product-name snapshot"
        integer quantity "CHECK > 0"
    }
    IDEMPOTENCY_RECORDS {
        varchar key PK
        varchar payload_hash
        uuid order_id FK_UQ "temporarily null inside uncommitted transaction"
        timestamptz created_at
    }
```

### Schema choices

| Relation | Key constraints / indexes | Reason |
|---|---|---|
| `inventory` | `sku` primary key; `available >= 0` check | One directly lockable balance row per SKU; invalid negative balances are rejected by the database too. |
| `orders` | UUID primary key; status check; status/cancellation-time consistency check; `created_at` index | Stable opaque order IDs; a cancelled order must have a cancellation timestamp and an active order must not. The time index supports a future chronological operator list. |
| `order_items` | FKs to order and inventory with `RESTRICT`; `quantity > 0`; unique `(order_id, sku)`; index on `sku` | Prevent orphaned lines and accidental duplicate SKU lines; supports order hydration and SKU-based investigation. `name` is snapshotted for historical display. |
| `idempotency_records` | Key primary key; unique nullable `order_id`; FK to order | The key is the cross-process arbitration point. A nullable association is permitted only during the transaction that creates the order; the claim and association commit atomically. |

`inventory.available` is the current balance, not a derived sum of order rows. A full append-only stock ledger would be valuable for audit/reconciliation at a larger scale, but it introduces more write and query complexity than this bounded challenge requires.

## 5. Order state and transitions

```mermaid
stateDiagram-v2
    [*] --> Active: all lines available / transaction commits
    [*] --> [*]: validation or stock failure / transaction rolls back
    Active --> Cancelled: DELETE / release lines and transition atomically
    Cancelled --> Cancelled: repeated DELETE / no stock change
```

There is deliberately no `pending` state: within this synchronous service, an order is externally visible only after its full reservation commits. A failed reservation creates no order and consumes no idempotency key. A future payment/fulfillment workflow would need an explicit reservation-expiry policy and state model.

### Idempotency state

```mermaid
stateDiagram-v2
    [*] --> Unclaimed
    Unclaimed --> Unclaimed: request fails / DB rollback
    Unclaimed --> Bound: key + payload hash + order commit together
    Bound --> Bound: same key + same canonical payload / return original order
    Bound --> Bound: same key + different payload / 409, no writes
```

The UI stores a draft and key in the current tab's `sessionStorage`. The database is the durable source of truth; browser storage is only a way to reuse the same request key after a retry or refresh.

## 6. Reservation transaction and concurrency

### Create-order transaction

For `POST /api/v1/orders`, one SQLAlchemy session and one PostgreSQL transaction:

1. Validate 1–100 lines, SKU syntax, quantity bounds, and one line per SKU.
2. Canonicalize the lines by SKU and calculate a SHA-256 payload hash.
3. Claim `Idempotency-Key` using `INSERT ... ON CONFLICT DO NOTHING`.
4. If the key already exists, lock/read the record. A different hash returns `409`; a matching hash returns the stored order without decrementing stock.
5. Lock all requested `inventory` rows in deterministic SKU order with `SELECT ... FOR UPDATE`.
6. Return `404` for unknown SKUs or `409` with per-SKU requested/available counts if any stock is short. Raising the HTTP error exits the transaction and rolls back the idempotency claim.
7. Decrement all balances with one parameterized `UPDATE ... FROM (VALUES ...)`, insert the order and item snapshots, and associate the key with the order.
8. Commit. Return `201`; a replay returns `200` and `Idempotency-Replayed: true`.

The availability check and decrement happen while the same rows are locked. The database's nonnegative check is a final guardrail. Because the order, lines, balance changes, and idempotency association are in the same commit, a later insert/update failure rolls all of them back.

### Why the last unit is safe

For two distinct keys requesting the same last unit, both transactions contend on the same inventory row. One obtains the row lock, observes one available unit, writes the order, decrements to zero, and commits. The waiting transaction then observes zero and returns `409`. No request can read one, both decrement, and commit a negative balance.

For overlapping multi-SKU requests, each transaction locks SKUs in sorted order. Deterministic lock acquisition reduces cyclic wait/deadlock risk; unrelated SKU sets can still proceed concurrently.

### Retry arbitration

The unique idempotency-key primary key, not an in-process lock, coordinates API instances. If an identical request arrives while the first is uncommitted, PostgreSQL's unique constraint arbitration waits for the winner. After it commits, the second request reads the bound order; if it rolls back, the second can claim the key and proceed. A different payload under the same key returns `409` with no state change.

### Cancellation transaction

`DELETE /api/v1/orders/{id}` locks the order row. If it is active, it loads the persisted line quantities, bulk-adds those quantities to inventory, sets `status = cancelled` and `cancelled_at`, and commits all changes together. A concurrent or repeated cancel waits on the order lock, then observes `cancelled` and returns the same order without another release.

## 7. Query efficiency and operational bounds

- SKU reads and lock acquisition use the `inventory` primary key.
- Order lookup is a UUID primary-key lookup plus one batched `selectinload` for order lines; it avoids one query per line.
- Reservation/release performs one set-based stock update rather than N updates.
- The `VALUES` rows are generated from a validated, capped request; SKU and quantity values remain bound parameters.
- An inventory collection read is ordered by primary key. For large catalogs, change it to cursor pagination and add a selective search/filter contract rather than returning an unbounded table.
- The engine enables `pool_pre_ping` and sets configurable pool size, overflow, and wait timeout. Size the pool against the PostgreSQL connection budget across all API replicas, not per replica in isolation.
- `/health/live` checks process liveness only. `/health/ready` checks PostgreSQL connectivity and returns `503` if the database cannot serve traffic.

## 8. REST API

Base path: `/api/v1`. Interactive OpenAPI: `http://localhost:8000/docs`.

Responses include an opaque `X-Request-ID` header for support and log correlation.

### Create reservation

`POST /api/v1/orders`

Required header: `Idempotency-Key` (1–128 characters).

```http
POST /api/v1/orders
Content-Type: application/json
Idempotency-Key: checkout-7b6e4c

{
  "items": [
    {"sku": "LAMP-001", "quantity": 2},
    {"sku": "MUG-002", "quantity": 1}
  ]
}
```

First success: `201 Created`.

```json
{
  "id": "41f7eb3e-3431-43ba-bf3d-bd1f6c32923f",
  "status": "active",
  "created_at": "2026-11-21T03:00:00+05:30",
  "cancelled_at": null,
  "items": [
    {"sku": "LAMP-001", "name": "Arc Desk Lamp", "quantity": 2},
    {"sku": "MUG-002", "name": "Stoneware Mug", "quantity": 1}
  ]
}
```

Same key and equivalent lines (line order does not matter): `200 OK`, same order body, header `Idempotency-Replayed: true`. Same key with a different payload: `409 Conflict`, no state change. Duplicate SKUs in one request are `422`; combine their quantities into one line.

### Retrieve, cancel, and inspect

| Method | Path | Success | Behavior |
|---|---|---:|---|
| `GET` | `/api/v1/orders/{order_id}` | `200` | Return persisted order and line snapshots; `404` if absent. |
| `DELETE` | `/api/v1/orders/{order_id}` | `200` | Cancel an active order and release quantities once. Repeating the request returns the cancelled order without another release. |
| `GET` | `/api/v1/inventory` | `200` | List current balances in SKU order. |
| `GET` | `/api/v1/inventory/{sku}` | `200` | Read one current balance; `404` if absent. |
| `GET` | `/health/live` | `200` | Process liveness. |
| `GET` | `/health/ready` | `200` / `503` | Database readiness. |

### Error contract

Errors use FastAPI's JSON `detail` field. Clients should branch on HTTP status and treat `detail` as structured data where supplied.

| Status | Example `detail` | Client action |
|---:|---|---|
| `404` | `{"message":"Unknown SKU.","skus":["MISSING-01"]}` | Correct/remove a SKU; no order or stock mutation. |
| `404` | `"Order not found."` | Check order ID. |
| `409` | `{"message":"Insufficient inventory.","items":[{"sku":"CHAIR-003","requested":4,"available":3}]}` | Refresh availability, adjust quantities, submit again. |
| `409` | `"Idempotency-Key was already used with a different payload."` | Use a new key only for a genuinely new request; do not silently retry changed data under the old key. |
| `422` | Pydantic validation details or `"Each SKU must appear at most once; combine duplicate lines."` | Fix the request shape, SKU, quantity, or combine duplicate SKU lines. |
| `503` | `"Database is unavailable."` from readiness probe | Remove the instance from service until the DB is healthy. |

## 9. Frontend organization and operator experience

```text
frontend/src/
  app/App.tsx                    Page composition and cross-feature orchestration
  features/
    inventory/InventoryPanel.tsx Inventory read state and presentation
    orders/
      OrderDetailsCard.tsx       Persisted order and cancel-confirmation view
      OrderLookupForm.tsx        Order-ID lookup form
      ReservationForm.tsx        Multi-line reservation draft
      errorMessages.ts           API-to-operator recovery language
      reservationState.ts        Draft persistence and idempotency-key helpers
  shared/api.ts                  Typed HTTP client and response types
  main.tsx                       Browser bootstrap
  styles.css                     Global visual tokens and layout
```

The page coordinates shared state and cross-feature actions; presentation and draft/idempotency logic live in feature-owned modules. `api.ts` keeps HTTP details out of the views. The reservation form permits one line per SKU, disables sold-out choices, and still treats the server as authoritative. A stock conflict names the item and both counts. Cancellation requires explicit confirmation. An order URL (`?order=<uuid>`) can be copied/shared, and the order ID can be copied from its detail card.

### Client state and server-data strategy

The current frontend uses React hooks and a typed `fetch` wrapper; it does **not** use Redux, RTK Query, or TanStack Query.

- **Local UI state:** `useState` owns the current form draft, lookup result, busy action, confirmation, and operator messages. This state is scoped to one operator page, so a global Redux store would add ceremony without solving a current cross-screen state problem.
- **Draft durability:** the reservation cart and its idempotency keys are kept in `sessionStorage` so a refresh or uncertain network response can safely reuse the same request identity.
- **Server data:** inventory is loaded on page mount and explicitly refreshed by the operator, after a successful reservation/cancellation, or after a stock conflict. Order details are fetched when an order ID is looked up. The typed API module centralizes request construction and error parsing.
- **Current trade-off:** there is no shared query cache, request deduplication, stale-time policy, background refetch, or automatic retry. For this single-screen, small-catalog challenge, explicit refresh behavior keeps freshness visible and the data flow easy to audit. `useMemo`/`useCallback` avoid a few unnecessary recalculations and callback recreations; they are not substitutes for a server-state cache.
- **Growth path:** if the UI adds multiple pages, frequent revalidation, or more consumers of the same order/inventory data, add TanStack Query for server state: query keys such as `["inventory"]` and `["orders", orderId]`, and `useMutation` for create/cancel with inventory invalidation after commit. Keep transient UI state and the retry-safe draft in React/session storage rather than duplicating them in the query cache.
- **Retry safety:** reads may use a bounded retry policy for transient network failures. Do not blindly retry reservation mutations; a retry must reuse the exact same idempotency key and payload. The backend remains authoritative for stock and idempotency.

## 10. Verification strategy

Backend tests require a real PostgreSQL server and run Alembic migrations automatically against the configured test database:

```powershell
Set-Location C:\Users\harsh\Desktop\Hackathon\backend
$env:DATABASE_URL = "postgresql+psycopg://reservations:reservations@localhost:5434/reservations"
uv sync --locked --extra dev
uv run --locked pytest -vv
```

| Test | Property verified |
|---|---|
| Two different keys, one unit, barrier-synchronized workers | Exactly one order/key is committed; exactly one request gets `409`; inventory ends at zero. |
| Same key/payload, overlapping workers | Both responses identify one order; stock is decremented once; one idempotency record exists. |
| Multi-item request with one unavailable SKU | Every balance is unchanged; no order or idempotency record is committed. |
| Key reused with changed payload | `409`; original order and all balances are unchanged. |
| Repeated cancellation | Exact quantities are released once; status and timestamp remain stable. |
| HTTP contract | Create/replay/read/cancel/inventory and liveness/readiness responses behave as documented. |

Frontend tests and production build:

```powershell
Set-Location C:\Users\harsh\Desktop\Hackathon\frontend
npm ci
npm test
npm run build
```

Frontend unit tests prove canonical retry-key behavior and operator-readable conflict/not-found messages. Browser smoke testing has also exercised multi-SKU reservation, stock conflict recovery, refresh-restored drafts, deep links, and cancellation.

## 11. Production gaps and deliberate next steps

These are explicit scope boundaries, not claims that the challenge build is production-ready:

1. **Tenant boundaries and identity:** add authenticated operator/service identities; scope inventory, orders, idempotency uniqueness, and every query by merchant/tenant.
2. **Auditability:** add immutable actor-attributed order events (created/cancelled) and inventory adjustments with reason codes. Reconcile balances against an append-only ledger.
3. **Payments and fulfillment:** if introduced, do not call remote services while holding stock locks. Commit an outbox event with the reservation, then start idempotent workers/workflows after commit. Temporal is a fit for long-running payment/fulfillment/expiry processes, not for replacing the stock transaction.
4. **Reservation expiry:** define expiration and payment semantics, then make the expiry worker contend on the same order lock and use the same one-time release transition as cancellation.
5. **Idempotency lifecycle:** define retention relative to client retry duration and order/audit requirements. Keep a tombstone or durable unique request identity for at least the maximum supported retry window.
6. **Schema evolution:** use reviewed Alembic migrations with expand/contract deploys; never call `create_all()` in production app startup.
7. **Reliability:** set request/statement/lock timeouts; observe pool saturation, lock wait time, reservation conflict rate, and rollback rate; retry only known transient SQLSTATEs with bounded jitter and a fresh transaction.
8. **Catalog scale:** cursor-paginate inventory and future order history. Load-test hot-SKU contention and size the connection pool/replica count against the database's lock and connection limits.
9. **Operations and security:** add centralized structured request logs, metrics/traces, alerting, secret management, CORS allow-listing per environment, rate limiting, backup/restore drills, and deployment runbooks.
10. **Product growth:** add a cursor-paginated order list/search and inventory adjustment flow only with audit controls and authorization.
