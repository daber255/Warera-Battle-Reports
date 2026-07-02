# Warera Reports — AGENTS.md

## API Dokumentation

- **Community-Doku (empfohlen):** https://github.com/zertw1/warera-bot/blob/main/API_documentation.md
- **OpenAPI JSON (offiziell):** https://api2.warera.io/openapi.json
- **WarEra API Docs (offiziell):** https://api2.warera.io/docs/
- **Community API Docs (majima):** https://majimawrks.github.io/warera-api-docs/

## Projektstruktur

```
Warera-Reports/
├── battle_cost_report.py          # Kostenreport für einzelne Battle
├── battle_cost_report_country.py  # Kostenreport für alle Battles eines Landes
├── country_cache.json             # Cache für Ländernamen
├── docs/                          # GitHub Pages Frontend
│   ├── index.html
│   ├── js/
│   │   ├── api.js                 # WarEra API Client (Frontend)
│   │   └── app.js                 # UI-Logik
│   └── css/
└── AGENTS.md                      # Diese Datei
```

## API Grundlagen

- **Basis-URL:** `https://api2.warera.io/trpc`
- **Auth:** `X-API-Key` Header (optional für einige Endpoints)
- **Rate Limit:** ~100 req/60s
- **Paginierung:** Cursor-basiert mit `limit` (max 100) und `cursor` Parametern
- **Response-Wrapper:** `result.data` enthält die eigentlichen Daten

## Wichtige Endpunkte

### battleRanking.getRanking
- Parameter: `battleId`, `dataType` (damage|points|money), `type` (user|country|mu), `side` (attacker|defender|merged)
- **Unterstützt Paginierung mit `limit` (max 100) und `cursor`!**
- Response-Key: `rankings` (ohne Paginierung) / `items` + `nextCursor` (mit Paginierung)
- Cursor-Feld: `nextCursor`

### mercenaryContractAuction.getPaginatedAuctions
- Parameter: `battleId`, `status` (won|active|expiredNoBids|...), `limit` (max 50), `cursor`
- Response: `items` + `nextCursor`

### battle.getBattles
- Parameter: `countryId`, `limit`, `cursor`, `direction` (forward|backward), `isActive`
- Response: `items` + `nextCursor`

### battle.getById
- Parameter: `battleId`
- Response: Battle-Objekt mit `attacker`/`defender` (enthalten `country`, `region`, `damages`, `hitCount`)

## Python Backend

### Bewährte Muster

**Paginierte API-Aufrufe:**
```python
all_items = []
cursor = None
while True:
    params = {"key": value, "limit": 100}
    if cursor:
        params["cursor"] = cursor
    raw = await call_with_retry(
        lambda p=params.copy(): client._http.get("endpoint.name", p)
    )
    items = extract_items(raw)
    if not items:
        break
    all_items.extend(items)
    cursor = raw.get("nextCursor")
    if not cursor:
        break
```

**`extract_items`** durchsucht Response nach `items`, `data`, `results`, `rankings`.

**Rate Limiter:** `call_with_retry` aus `lib.ratelimiter` — retry bei Fehlern.

### Bounty-Formel
```
bounties = total_mu_money - completed_contract_payouts
```
Beide Seiten MÜSSEN paginiert werden, sonst werden Bounties negativ (Contracts von MUs außerhalb des Top-Rankings fehlen im Money-Total).

## JavaScript Frontend (docs/)

### Bewährte Muster

**Paginierte API-Aufrufe über `apiCallAll`:**
```js
const items = await Warera.getAllRanking({ battleId, dataType: 'money', type: 'mu', side: 'attacker', limit: 100 });
```

Verfügbare `Warera.*` Methoden in `api.js`:
- `getRanking(params)` — einzelne Seite
- `getAllRanking(params)` — alle Seiten (paginiert)
- `getAllContracts(params)` — alle Contracts
- `getAllBattles(params, stopDate)` — alle Battles
- `getBattleById(battleId)`, `getCountryById(id)`, `getRegionById(id)`, etc.

**Rate Limiter integriert** (80 req/60s, Token-Bucket).

## Deployment

- GitHub Pages: `docs/` wird automatisch deployed via `main`-Branch
- Python-Skripte benötigen `WARERA_API_KEY` in `.env`
