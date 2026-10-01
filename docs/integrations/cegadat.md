# Cégadat API — integration notes

Implemented against **API v1.4 (2026-02-05)**, read from
<https://cegadatapi.hu/dokumentacio> on 2026-10-01. Code:
`src/modules/registry/cegadat.ts` (client + mapping),
`src/modules/registry/registry-service.ts` (cache, quota, ledger).

## Contract as found

| | |
|---|---|
| Base URL | `https://api.cegadatapi.hu` |
| Auth | `X-Api-Key: <key>` header |
| Search | `GET /v1/search` — `name` (min. 4 chars) **or** `vatNumber` **or** `registryNumber`; optional `businessType` (`company` default, `individualEntrepreneur`, `publicSector`, `nonProfit`, `otherOrganization`, `all`), `sensitivity` (0 typo-tolerant default, 1 partial, 2 exact), `status` (`Aktív`, `Eljárás alatt`, `Szüneteltetett`), `limit` 1–100 (default 50), `page`. **Unlimited on every plan.** |
| Detail | `GET /v1/detail?id=<11-digit tax number>`. **Metered**: 5,000/month on Haladó. An unknown tax number answers `200` with `results: []`. |
| Errors | `{ status: false, error, errorCode, statusCode }`. 1 invalid key (400), 2 invalid call (400), 3 internal (500), 4 keyword too short (400), 5 subscription (401), 6 plan (401), **7 package limit reached (429)**, 404 unknown endpoint. |
| Test key | Published in the documentation; answers for six companies (WellData, DAYTON-Invest, Coca-Cola HBC Magyarország, Budapest Film, two sole traders). |

## Differences from the playbook's summary

The playbook described the API from memory and said to verify. It was wrong in
these places, and the code follows the documentation:

- the host is `api.cegadatapi.hu`, not `cegadatapi.hu/api`;
- auth is `X-Api-Key`, not `Authorization: Bearer`;
- search takes `name` / `vatNumber` / `registryNumber` directly, not
  `q` + `searchType`; detail takes `id`, not `vatNumber`;
- `managers[]` and `owners[]` are plain **name strings** — the registry gives
  no role, so a "named manager" in the contact waterfall is a name only;
- money fields come as numbers on some sheets and strings on others; sole
  traders report `revenue`/`netIncome` instead of the company set;
- `netSalesRevenues` is the after-tax result (it sits just below
  `earningsBeforeTaxes` on every captured sheet), and is mapped as such;
- activities are strings like `"6392. Egyéb információs szolgáltatás"`; sole
  traders carry six-digit codes. Segment matching is by prefix, so both work;
- none of the test companies returned `website`, `phoneNumber` or
  `emailAddress`; the contact mapping is tested on a synthetic fixture shaped
  like the documented example.

## Quota rules (CLAUDE.md hard rule 12)

- Every detail call goes through `getDatasheet()`: 90-day cache per tax
  number (not-found answers are cached too), quota check, ledger row.
- Cache hits are ledgered with `cacheHit = true` and never charged.
- Batch purposes (`NIGHTLY_RUN`, `MANUAL_RUN`) get a daily allocation of what
  the batch share had left at the start of the day ÷ days left in the month.
  The reserve (default 15%) is reachable only by interactive purposes.
- Error 7 / HTTP 429 becomes `quota_exhausted` — the caller pauses.

## Fixtures

`test/fixtures/cegadat/` — real responses for the six test companies, captured
2026-10-01 and scrubbed of private persons' data (see the README there).
