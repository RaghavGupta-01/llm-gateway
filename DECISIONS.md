# DECISIONS.md

## 1. What I built

A small HTTP gateway (TypeScript, Express) that sits in front of Google Gemini. Callers use gateway-issued virtual keys, so the Gemini key never leaves the server. Each key has a budget, enforced with one atomic SQL statement before the provider is called, and every request is logged to Neon Postgres. If Gemini fails, the gateway retries once and then falls back to an in-process mock provider.

**Stack:** Node.js 20, Express, Postgres on Neon via `pg` with raw SQL (no ORM, so the budget SQL is explicit and easy to audit), `zod`, `vitest`.
**Deployed:** Render, https://llm-gateway-mfbc.onrender.com/. **Boilerplate:** none, built from scratch.

---

## 2. Moving parts and request lifecycle

```
Client (curl / Postman)
   │  Authorization: Bearer gw_...
   ▼
┌───────────────────────────── Gateway (Express) ─────────────────────────────┐
│ 1. auth          : sha256(token) -> api_keys lookup (401 if bad/revoked)    │
│ 2. validate      : zod; model must be in price table; clamp max_tokens      │
│ 3. reserve       : atomic conditional UPDATE (402 if over budget)           │
│ 4. call provider : Gemini, 10s timeout, retry once on transient error       │
│ 5. fallback      : mock provider if Gemini still fails (status fallback_ok) │
│ 6. settle        : replace estimate with actual cost + insert usage_log     │
│ 7. respond       : provider JSON + x-gateway-provider header                │
│    total failure : release reservation, log 'failed', return 502            │
└──────────────────────────────────────────────────────────────────────────────┘
        │                                   │
        ▼                                   ▼
   Neon Postgres                  Gemini (OpenAI-compatible endpoint)
 (api_keys, usage_logs)           + in-process mock provider (fallback)
```

The budget is checked **before** the provider call (step 3) using a worst-case estimate: `ceil(prompt chars / 4)` input tokens plus `max_tokens` output tokens, priced from a hardcoded table. After the call, step 6 swaps the estimate for the real cost from the provider's `usage` block, in one transaction with the log insert.

---

## 3. Key decisions

### 1. Money unit: micro-rupees (integer)
- **Options:** floating-point rupees; integer paise; integer micro-rupees (₹1 = 1,000,000 units).
- **Picked:** micro-rupees, stored as `BIGINT` and handled as JS `bigint`.
- **Why:** A short LLM call costs a small fraction of a paisa (about 0.05–0.14 paise for 20 input tokens at my price-table rates), so whole paise would round it to 0 and the budget would barely move. Floats accumulate rounding error, and the budget check needs exact integers.
- **Tradeoff accepted:** The unit is less intuitive. Budgets are entered in rupees and converted at the API edge.
- **Alternative:** paise with round-up and a 1-paisa minimum charge per request. Simpler, but it overcharges small requests, so spend would no longer match real cost.

### 2. OpenAI-compatible API on both sides
- **Options:** own schema; Gemini's native API through the Google SDK; OpenAI-compatible `/v1/chat/completions`.
- **Picked:** OpenAI-compatible for callers, and Gemini's OpenAI-compatible endpoint upstream, called with `fetch`.
- **Why:** Any OpenAI client works by changing the base URL, and providers (Gemini, mock) share one shape, so fallback needs no translation code.
- **Tradeoff accepted:** Only the common feature subset is available; Gemini-only features are not.

### 3. Non-streaming only
- **Options:** streaming (SSE); non-streaming.
- **Picked:** non-streaming. `stream: true` is rejected with 400.
- **Why:** The exact token count arrives with the response, so the final charge is exact. Streaming adds mid-stream failures, dropped connections and partial billing, which would make the budget logic and fallback much harder.
- **Tradeoff accepted:** Callers can't show text as it is generated.

### 4. Synchronous usage logging
- **Options:** async (queue or batch); synchronous insert.
- **Picked:** synchronous, in the same transaction that settles the spend.
- **Why:** The spend counter and the log row can never disagree, and no log is lost if the process dies right after responding.
- **Tradeoff accepted:** One extra database write adds latency to every request, and a database problem affects the response path.

### 5. API keys stored as SHA-256 hashes
- **Options:** plaintext; bcrypt/argon2; SHA-256.
- **Picked:** SHA-256 of a random 24-byte key.
- **Why:** The keys are long random strings, not human passwords, so brute force isn't a realistic attack. A fast hash also lets the lookup be a single indexed query by hash (bcrypt's salting would prevent that), with no added latency.
- **Tradeoff accepted:** This is only safe because the gateway generates the keys itself. If users could choose their own keys, it would not be.

---

## 4. Why enforce budgets at the gateway instead of trusting callers?

Callers can be buggy or compromised: a retry loop or a leaked key can burn real money before anyone notices, and a caller-side limit is one the caller can ignore. The gateway is the only place that holds the real provider key and sees every request, so it is the only place where a limit can't be bypassed. Callers get virtual keys, which can be capped or revoked without touching the provider key.

---

## 5. Concurrency

**Handled.** If a key has room for two requests and ten arrive at once, exactly two proceed and eight get a 402.

**The risk.** "Read the balance, check it in code, then write it" lets several requests read the same old balance and all pass, so the key overshoots.

**The fix.** The check and the increment are one SQL statement in `src/budget.ts`:

```sql
UPDATE api_keys
   SET spent_micro = spent_micro + $2
 WHERE id = $1
   AND revoked_at IS NULL
   AND spent_micro + $2 <= budget_micro
```

Postgres locks the key's row while updating it, so concurrent requests for the same key are handled one at a time. A waiting request re-checks the condition against the updated value. If it fails, zero rows are updated and the code returns `402` before any provider call.

**Verified by** `tests/concurrency.test.ts`: 10 parallel requests against a key with room for 2 gave 2 successes, 8 rejections, and `spent <= budget`.

**Knowingly not covered:** the reservation is an estimate, so real usage can slightly exceed it (output is bounded by the `max_tokens` cap), and a crash between reserve and settle leaks a reservation (see section 9).

---

## 6. Fallback policy and why

1. Call Gemini with a 10s timeout (`AbortController`).
2. **Retryable errors** (timeout, network error, 429, 5xx): wait ~300ms plus jitter, retry once.
3. If the retry also fails, fall back to the in-process mock provider. The response carries `x-gateway-provider: mock` and the log row is `fallback_ok`.
4. **Fatal errors** (400-class errors caused by the caller's request): no retry, no fallback. Retrying would only repeat the error, and falling back would hide it. The reservation is released and the error is returned.
5. If the fallback also fails, release the reservation, log `failed`, return 502.

**Billing:** only real provider calls are charged. A mock response costs nothing, so the reservation is fully refunded.

**Why:** one bounded retry absorbs short blips, and worst-case latency stays around 2 x timeout + backoff. Past that, a degraded but honest answer is better than an unbounded wait.

**Tradeoff accepted:** the mock returns a fake answer with a 200, so a caller who ignores the header would treat it as real. In production I'd fall back to a second real provider or fail fast with a 503.

`MOCK_FORCE_PRIMARY_FAIL=true` makes Gemini fail on demand, which is how fallback is demoed and tested.

---

## 7. What I deliberately did NOT build, and why

- **Streaming:** see decision 3.
- **Frontend:** not scored; two admin endpoints are enough to create keys and view spend.
- **User accounts, OAuth, roles, key rotation:** simple gateway-issued keys are all the task needs.
- **Storing prompts or responses:** avoids privacy and storage liabilities; only metadata is logged.
- **Caching (exact or semantic):** extra infrastructure and invalidation problems before the core was proven.
- **Rate limiting:** the budget caps total use, but not bursts.
- **Async logging or a queue:** see decision 4.
- **Stretch items (local model, router):** I put the time into testing the core instead.

---

## 8. The decision I'm least confident about

**Estimating input tokens as `characters / 4` for the reservation.**

- **For:** it's instant, needs no tokenizer dependency, and `settle` replaces the estimate with the provider's real usage afterwards, so the estimate only affects the temporary hold.
- **Against:** 4 characters per token is roughly right for English, but it undercounts for CJK text, emoji and dense code. The reservation can then be too small, and a key can overshoot by the gap. In the other direction, a large `max_tokens` holds a lot of budget while the call is running, so concurrent requests on a near-empty key can be rejected even though their real cost would have fit.
- **What would change my mind:** a real tokenizer or the provider's token-count call, or a more conservative multiplier such as `characters / 2`.

---

## 9. Where it breaks, and what I'd do with one more week

- **Leaked reservations:** a crash between reserve and settle leaves budget marked as spent. Fix: a `reservations` table with an expiry and a small sweeper.
- **Single database:** if Neon is down the gateway is down, even when Gemini is fine. Fix: a highly available Postgres. I would keep the budget counter in Postgres, since moving it to a cache would weaken the atomic guarantee.
- **Static price table:** prices and the exchange rate are hardcoded, so they drift until redeployed. Fix: store them in a table that an admin can update.
- **Mock fallback returns a fake 200:** fine for a demo, not for real users. Fix: a second real provider (for example Groq) or fail fast with a 503.
- **No rate limiting and a single static admin token:** fix: per-key rate limits and proper admin auth.
- **Free-tier limits:** Gemini 429s, and Render and Neon cold starts make the first request after idle slow. Fix: a paid tier or a keep-alive.