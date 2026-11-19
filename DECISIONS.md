## 1. What I built

## 2. Moving parts and request lifecycle

## 3. Key decisions

### 1. Money unit: micro-rupees (integer)

- **Options:** floating-point rupees; integer paise; integer micro-rupees (₹1 = 1,000,000 units).
- **Picked:** micro-rupees, stored as `BIGINT`.
- **Why:** A short LLM call costs a tiny fraction of a paisa. For example, 20 input tokens on Gemini 3.6 Flash is about ₹0.0013, or 0.13 paise (assuming $1 = ₹93). Whole paise would round that to 0, so the budget would never drop. Floats were rejected because they accumulate rounding errors, and the budget check needs exact integers.
- **Tradeoff accepted:** The unit is less intuitive. Budgets are entered in rupees and converted at the API edge, and Node needs explicit `BigInt` handling because `pg` returns `BIGINT` as strings.
- **Alternative I considered:** Paise with round-up and a 1-paisa minimum charge per request. It's simpler, but it overcharges small requests, so spend would no longer match real cost.

## 4. Why enforce budgets at the gateway instead of trusting callers?

## 5. Concurrency

## 6. Fallback policy and why

## 7. What I deliberately did NOT build, and why

## 8. The decision I am least confident about

## 9. Where it breaks, and what I would do with one more week