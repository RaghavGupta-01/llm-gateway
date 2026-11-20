# LLM-Gateway

A minimal LLM gateway: gateway-issued API keys, per-key budgets, usage logging, and resilient fallback in front of Gemini.

**Live:** https://llm-gateway-mfbc.onrender.com (free tier, the first request may take ~30-60s to wake)

## Try it

### 1. Authentication & Setup

Before running requests, set your environment variables:

```bash
# Deployed base URL
URL="https://llm-gateway-mfbc.onrender.com"

# The live ADMIN_TOKEN for this deployed URL is provided in the submission email.
# (For local testing, generate your own with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
ADMIN_TOKEN="<PASTE_ADMIN_TOKEN_HERE>"
```

- **`ADMIN_TOKEN`** is used by the operator to provision keys (`POST /admin/keys`) and view usage metrics (`GET /admin/usage/:keyId`).
- The virtual key **`gw_...`** generated from `POST /admin/keys` is used by client callers to authenticate chat completions (`POST /v1/chat/completions`).

---

### 2. Request Flow

#### Step 1: Create a Virtual Key (Admin)
Allocate a budget in rupees (e.g. ₹5 = 5,000,000 micro-rupees):

```bash
curl -X POST $URL/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo-user","budget_inr":5}'
```

*Response:*
```json
{
  "id": "c1f7a2d4-0000-0000-0000-000000000000",
  "key": "gw_Xk3j89bZ...",
  "budget_micro": 5000000
}
```
> Both the `id` and the virtual key `key` come from this response. The raw `gw_...` key is displayed **once** and never stored.

#### Step 2: Call Chat Completions (Virtual Key)
Use the `gw_...` key returned from Step 1 as your Bearer token:

```bash
curl -i $URL/v1/chat/completions \
  -H "Authorization: Bearer gw_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.5-flash-lite","messages":[{"role":"user","content":"Say hi"}],"max_tokens":50}'
```

#### Step 3: Inspect Spend & Usage (Admin)
Use the `id` from Step 1 with your `$ADMIN_TOKEN` to check remaining budget and request logs:

```bash
curl $URL/admin/usage/<KEY_ID> \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Tech stack

- **Runtime:** Node.js 20+ ,TypeScript (`strict: true`), Express
- **Database:** Neon Postgres (serverless, pooled connection)
- **Driver:** `pg` (node-postgres), raw SQL, no ORM
- **Validation:** `zod`
- **Testing:** `vitest` + `supertest`
- **Provider HTTP:** Built-in `fetch` + `AbortController`

## API

| Endpoint | Auth | Status Codes | Purpose |
|---|---|---|---|
| `GET /health` | None | `200`, `503` | Service liveness & DB `SELECT 1` ping |
| `POST /admin/keys` | Bearer `$ADMIN_TOKEN` | `201`, `400`, `401` | Create virtual API key  |
| `GET /admin/usage/:keyId` | Bearer `$ADMIN_TOKEN` | `200`, `401`, `404` | View spend, remaining balance, and latest request logs |
| `POST /v1/chat/completions` | Bearer `gw_...` | `200`, `400`, `401`, `402`, `502` | OpenAI-compatible proxy with budget reservation & fallback |

Every chat response carries the `x-gateway-provider: gemini | mock` header. Set `MOCK_FORCE_PRIMARY_FAIL=true` to simulate primary provider outage and observe automatic fallback to `x-gateway-provider: mock` (`status: fallback_ok`, charged at ₹0).

## Run locally

Requires Node.js 20+.

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env.local

# Run database migrations
npm run migrate

# Development (hot-reload)
npm run dev

# Production build and run
npm run build
npm start
```

*Docker deployment:* `docker build -t llm-gateway . && docker run -p 3000:3000 --env-file .env.local llm-gateway`

## Environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Neon Postgres pooled connection string (`sslmode=require`) |
| `DATABASE_URL_UNPOOLED` | Neon Postgres direct connection string (for migrations) |
| `ADMIN_TOKEN` | Secret token (min 32 chars) for `/admin/*` endpoints |
| `GEMINI_API_KEY` | Google AI Studio provider key |
| `PORT` | Local port (default `3000`) |
| `GEMINI_BASE_URL` | Upstream OpenAI-compatible Gemini URL |
| `PROVIDER_TIMEOUT_MS` | Upstream request timeout in ms (default `10000`) |
| `MOCK_FORCE_PRIMARY_FAIL` | Set to `true` to force primary failure and demo fallback |

## Tests

```bash
# Run full test suite (uses mock provider, zero API quota burn)
npm test
```

## More

See [DECISIONS.md](DECISIONS.md) for architectural tradeoffs and [AI-LOG.md](AI-LOG.md) for development notes.
