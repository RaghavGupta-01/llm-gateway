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

## 6. Fallback policy and why

## 7. What I deliberately did NOT build, and why

## 8. The decision I am least confident about

## 9. Where it breaks, and what I would do with one more week