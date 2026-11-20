## 1. What I built

## 2. Moving parts and request lifecycle

## 3. Key decisions

### 1. Money unit: micro-rupees (integer)

- **Options:** floating-point rupees; integer paise; integer micro-rupees (₹1 = 1,000,000 units).
- **Picked:** micro-rupees, stored as `BIGINT`.
- **Why:** A short LLM call costs a tiny fraction of a paisa. For example, 20 input tokens on Gemini 3.6 Flash is about ₹0.0013, or 0.13 paise (assuming $1 = ₹93). Whole paise would round that to 0, so the budget would never drop. Floats were rejected because they accumulate rounding errors, and the budget check needs exact integers.
- **Tradeoff accepted:** The unit is less intuitive. Budgets are entered in rupees and converted at the API edge, and Node needs explicit `BigInt` handling because `pg` returns `BIGINT` as strings.
- **Alternative I considered:** Paise with round-up and a 1-paisa minimum charge per request. It's simpler, but it overcharges small requests, so spend would no longer match real cost.

### 2. Public API shape and provider access

- **Options:** own schema; Gemini-native schema via the Google GenAI SDK; OpenAI-compatible chat/completions.
- **Picked:** OpenAI-compatible on both sides: callers use /v1/chat/completions, and the gateway calls Gemini's OpenAI-compatible endpoint with fetch.
- **Why:** Any OpenAI SDK works by changing the base URL, providers (Gemini, mock) share one shape so fallback is trivial, and there is almost no translation code in the critical path.
- **Tradeoff accepted:** I only get the common subset of features and depend on Google's compatibility layer matching the OpenAI behavior. Gemini-only features are unavailable.

## 4. Why enforce budgets at the gateway instead of trusting callers?

## 5. Concurrency

**Handled.** If a key has room for two requests and ten arrive at once, exactly two proceed and eight get a 402.

**The risk.** A naive "read the balance, check it in code, then write it" lets several requests read the same old balance and all pass, so the key overshoots:

```
A: SELECT spent (sees 0) -> OK -> UPDATE spent = 330
B: SELECT spent (sees 0) -> OK -> UPDATE spent = 330   <- overshoot
```

**The fix.** The check and the increment are a single SQL statement in `src/budget.ts`:

```sql
UPDATE api_keys
   SET spent_tokens = spent_tokens + $2
 WHERE id = $1
   AND revoked_at IS NULL
   AND spent_tokens + $2 <= budget_tokens
```

- Postgres takes a row lock on the key while updating it. The statement runs in autocommit, so the lock is released as soon as it finishes.
- A concurrent request waits for that lock, then re-checks the condition against the updated value.
- If the condition fails, zero rows are updated. The code checks `rowCount === 1`, and on 0 it returns `402` before any provider call.

No application-level locks are needed, because the database serializes requests for the same key.

**Verified by** `tests/concurrency.test.ts`: 10 parallel requests against a key with room for 2 gave 2 successes, 8 rejections, and `spent <= budget`.

**Not covered (knowingly):**
- The reservation is an estimate. If the real usage exceeds it, a key can overshoot slightly. The `max_tokens` cap bounds this.
- A crash between reserve and settle leaks a reservation. A reservations table with expiry would fix it.

## 6. Fallback policy and why

**Policy**

1. Call Gemini with a hard 10s timeout (`AbortController`).
2. **Retryable errors** (timeout, network error, 429, 5xx): wait ~300ms plus jitter and retry once.
3. If the retry also fails, fall back to the in-process mock provider. The response carries `x-gateway-provider: mock` and the log row is marked `fallback_ok`, so degraded responses are auditable.
4. **Fatal errors** (400-class errors caused by the caller's request): no retry and no fallback. The input is the problem, so retrying only repeats the error and hides it. The reservation is released and the error is returned.
5. If the fallback also fails, release the reservation, log `failed`, and return 502.

**Billing:** only successful real provider calls are charged. A mock response costs nothing, so the full reservation is refunded.

**Why this shape**

- A single bounded retry absorbs short blips like a dropped connection or a brief 429, without making the caller wait long. Worst-case latency is about 2 x timeout + backoff.
- Retrying 4xx errors would waste calls and quota, and falling back on them would mask the caller's mistake.
- Falling back keeps the service responding during a provider outage, and the header and log status keep it honest.

**Roles of the mock provider**

It serves as the fallback and as the test provider. `MOCK_FORCE_PRIMARY_FAIL=true` makes the primary fail on demand, which is how the fallback is demoed and tested without waiting for a real outage.

**Tradeoff accepted**

The mock returns a fake answer with a 200, so a caller who ignores the header would treat it as real. In production I'd fall back to a second real provider (for example Groq/ollama) or fail fast with a 503 instead.
## 7. What I deliberately did NOT build, and why

## 8. The decision I am least confident about

## 9. Where it breaks, and what I would do with one more week