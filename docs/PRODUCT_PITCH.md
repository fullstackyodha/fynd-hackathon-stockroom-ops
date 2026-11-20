# Stockroom | Hackathon product pitch

## Product in one sentence

**Stockroom helps merchants reserve scarce inventory without overselling, and gives operators a clear way to investigate and safely resolve an order.**

## The problem

A merchant with one unit left receives two orders at nearly the same time. Both requests can read “one available” before either writes. Without coordinated reservation, the business promises the same product twice.

The other failure is quieter: a buyer's request succeeds, but the response times out. The buyer retries. If the service treats the retry as a new order, it reserves stock twice and creates a support issue that is hard to untangle.

The cost is not only an incorrect stock number. It is a broken promise to a buyer, manual support work, and lost operator confidence in the inventory screen.

## Who it is for

- **Primary user:** a small-to-mid-size merchant operations/support operator handling order questions and stock checks.
- **Affected customer:** a buyer who expects one successful checkout to result in one reservation.
- **Business owner:** a merchant who needs to protect scarce stock and reduce avoidable cancellations.

## The promise

1. **One request, one order:** retrying the same request cannot create a second reservation.
2. **All items or none:** a multi-item basket is never partially reserved.
3. **A clear answer under contention:** when the last unit goes to another order, the operator sees an actionable stock conflict rather than a silent oversell.
4. **Safe recovery:** a cancellation explains its inventory effect and releases the persisted quantities once.

## Demo flow (about 90 seconds)

1. **Set context — 10 sec:** point out the live inventory table and the limited-edition print with one unit available.
2. **Show the operator workflow — 15 sec:** reserve two different SKUs together and point out the single generated order ID and the stock decrement.
3. **Prove the race — 25 sec:** run the barrier-synchronized last-unit test. Two independent buyers start together; one order commits, one receives `409`, and final stock is zero—not negative.
4. **Show retry safety — 15 sec:** run the overlapping same-key test. Both callers get the same order ID, with one stock decrement.
5. **Show atomic failure — 10 sec:** request two items where one is unavailable. The test verifies both balances stay unchanged and no order/idempotency record is written.
6. **Close on operations — 15 sec:** look up an order, show the itemized record, confirm cancellation, and point to the exact stock release.

### Suggested live commands

```powershell
# Start the full demo stack from the project root.
docker compose up --build

# In a backend shell with PostgreSQL running, prove the last-unit race.
Set-Location C:\Users\harsh\Desktop\Hackathon\backend
uv run --locked pytest -vv -k distinct_requests_competing_for_last_unit
```

## 60-second spoken pitch

> When a merchant has one unit left, two checkouts can arrive before either one updates stock. The result is a promise the merchant cannot keep. Retries add another failure mode: a timeout can accidentally become a second order.
>
> Stockroom makes reservation a single database decision. It locks the relevant inventory rows, checks the entire basket, and commits stock, order lines, and the retry key together—or commits none of them. A second buyer waits and gets a clear out-of-stock response. A repeated request gets the original order, not another decrement.
>
> We paired that core with an operator view: look up an order, see current sellable stock, understand exactly why a reservation failed, and confirm a cancellation before stock is released. The tests force the race with synchronized workers and inspect the final database records. The result is a small, explainable foundation for trustworthy inventory—not another dashboard that only displays a number.

## Why this is useful to a business

| Business concern | Product behavior | Expected outcome to measure |
|---|---|---|
| Oversold scarce items | Database-serialized stock reservation | Oversell incidents per 1,000 attempted reservations |
| Duplicate orders after timeout | Durable idempotency key and payload match | Duplicate orders per 1,000 client retries |
| Confusing partial baskets | Atomic all-lines-or-none transaction | Partial reservation incidents (target: zero) |
| Support has to ask engineering to investigate | Order lookup and itemized status | Median order-investigation time |
| Cancellation accidentally returns stock twice | Explicit confirmation and idempotent cancellation | Duplicate stock-release incidents (target: zero) |
| Operators do not trust displayed availability | Freshness time, refresh action, clear conflict recovery | Reservation conflict resolution time |

These are proposed success metrics, not measured outcomes. The hackathon implementation is not claiming production impact without a live merchant pilot.

## Differentiators

- The correctness story is enforced by PostgreSQL constraints and transactions, not a frontend check or in-memory mutex.
- Idempotency is durable across API instances and process restarts.
- The operator surface communicates what happened and what action is safe next.
- A failed multi-SKU reservation leaves no partial stock movement.
- The implementation stays one service and one database; long-running workflows are not introduced into the critical section.

## Demo limitations to state honestly

- This is a synthetic, single-merchant challenge environment with seeded products.
- The service has no authentication, payment capture, fulfillment, automatic reservation expiry, or audited inventory-adjustment endpoint.
- Browser persistence is scoped to the current tab; PostgreSQL remains the authority for order/idempotency history.
- Availability shown in the UI is advisory. Concurrent buyers may change it before the next request.

## Product roadmap

### Next: safe operations

- Operator authentication and role-based permissions.
- Order history/search with cursor pagination.
- Audited stock adjustments with reason and actor.
- Defined reservation TTL and a scheduled expiry/release path.
- Request IDs, audit history, and operator-facing retry diagnostics.

### Then: transactionally integrated commerce workflows

- Payment/fulfillment events written to a transactional outbox.
- Idempotent downstream workers; use Temporal only where a durable, long-running workflow adds value.
- Reconciliation between a stock movement ledger and the materialized sellable balance.
- Merchant-scoped rate limits, dashboards, alerts, and restore-tested backups.

## Q&A prompts to prepare for

**Why row locks instead of a distributed lock?**
The balance already lives in PostgreSQL. A row lock, constraints, and one transaction make the stock decision and order durable together. A distributed lock would add another failure mode without replacing the database transaction.

**Why not Temporal for the reservation itself?**
The inventory decrement and order must be atomic in one database. Temporal coordinates long-running work across services; it cannot make a database write and a workflow-history write one ACID commit. Use a transactional outbox after the reservation commits.

**What happens if the API crashes after commit but before the client receives the response?**
The caller retries with the same idempotency key. The unique database record resolves the retry to the committed order.

**What is the first production change?**
Tenant-scoped authentication/authorization and an audit/event model, then migrate the schema and instrument lock waits, pool use, reservation conflicts, and retry rates before scaling based on measured bottlenecks.
