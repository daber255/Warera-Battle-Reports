#!/usr/bin/env python3
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from dotenv import load_dotenv
from warera import WareraClient

script_dir = Path(__file__).parent
load_dotenv(script_dir.parent / ".env")

# ── Config ────────────────────────────────────────────────────
BATTLE_ID = "6a166e21912e4f61ebb8d84a"
# ──────────────────────────────────────────────────────────────

cache_dir = script_dir / "cache"
cache_dir.mkdir(parents=True, exist_ok=True)


import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from lib.ratelimiter import call_with_retry


def extract_items(response):
    if not response:
        return []
    if isinstance(response, list):
        return response
    if isinstance(response, dict):
        for key in ("items", "data", "results", "rankings"):
            val = response.get(key)
            if isinstance(val, list):
                return val
    return []


async def get_country_name(client, country_id):
    try:
        co = await call_with_retry(
            lambda: client._http.get("country.getCountryById", {"countryId": country_id})
        )
        return co.get("name") or co.get("name_lower") or country_id
    except Exception:
        return country_id


async def get_region_name(client, region_id):
    try:
        reg = await call_with_retry(
            lambda: client._http.get("region.getById", {"regionId": region_id})
        )
        code = reg.get("code", "")
        for prefix in ("de-", "dk-"):
            code = code.replace(prefix, "")
        return code.replace("-", " ").title() or region_id
    except Exception:
        return region_id


async def main():
    api_key = os.environ.get("WARERA_API_KEY")
    if not api_key:
        print("ERROR: WARERA_API_KEY not set!")
        sys.exit(1)

    battle_id = BATTLE_ID
    print(f"Battle cost report for: {battle_id}\n")

    async with WareraClient(api_key=api_key) as client:
        # ── 1. Battle info ────────────────────────────────────
        print("Fetching battle info...", flush=True)
        battle = await call_with_retry(
            lambda: client._http.get("battle.getById", {"battleId": battle_id})
        )
        att_info = battle.get("attacker") or {}
        def_info = battle.get("defender") or {}
        att_country_id = att_info.get("country")
        def_country_id = def_info.get("country")

        att_name = await get_country_name(client, att_country_id)
        def_name = await get_country_name(client, def_country_id)
        is_active = battle.get("isActive", False)

        # Region info
        att_region_id = att_info.get("region")
        def_region_id = def_info.get("region")
        att_region = await get_region_name(client, att_region_id)
        def_region = await get_region_name(client, def_region_id)

        # Date
        created = battle.get("createdAt", "")[:10]

        print(f"  {att_name} (attacker) vs {def_name} (defender)")
        print(f"  Region: {att_region} (A) / {def_region} (D)")
        print(f"  Date: {created}\n")

        # ── 2. Mercenary contracts (status=won) ───────────────
        print("Fetching completed mercenary contracts...", flush=True)
        all_contracts = []
        cursor = None
        while True:
            params = {
                "battleId": battle_id,
                "status": "won",
                "limit": 50,
            }
            if cursor:
                params["cursor"] = cursor
            merc_raw = await call_with_retry(
                lambda p=params.copy(): client._http.get("mercenaryContractAuction.getPaginatedAuctions", p)
            )
            items = extract_items(merc_raw)
            if not items:
                break
            all_contracts.extend(items)
            cursor = merc_raw.get("nextCursor")
            if not cursor:
                break

        # ── 3. MU money ranking per side (paginated) ─────────
        print("Fetching MU money ranking per side...", flush=True)
        mu_data = {}
        for side, label in [("attacker", att_name), ("defender", def_name)]:
            all_items = []
            cursor = None
            while True:
                params = {
                    "battleId": battle_id, "dataType": "money", "type": "mu", "side": side,
                    "limit": 100,
                }
                if cursor:
                    params["cursor"] = cursor
                raw = await call_with_retry(
                    lambda p=params.copy(): client._http.get("battleRanking.getRanking", p)
                )
                items = extract_items(raw)
                if not items:
                    break
                all_items.extend(items)
                cursor = raw.get("nextCursor")
                if not cursor:
                    break
            mu_data[side] = all_items
            total = sum(float(e.get("value") or 0) for e in mu_data[side])
            print(f"  {label}: {len(mu_data[side])} MUs — {total:.2f} btc")

        # ── 4. MU damage ranking per side (paginated) ────────
        print("Fetching MU damage ranking per side...", flush=True)
        mu_damage = {"attacker": {}, "defender": {}}
        for side, label in [("attacker", att_name), ("defender", def_name)]:
            all_items = []
            cursor = None
            while True:
                params = {
                    "battleId": battle_id, "dataType": "damage", "type": "mu", "side": side,
                    "limit": 100,
                }
                if cursor:
                    params["cursor"] = cursor
                raw = await call_with_retry(
                    lambda p=params.copy(): client._http.get("battleRanking.getRanking", p)
                )
                items = extract_items(raw)
                if not items:
                    break
                all_items.extend(items)
                cursor = raw.get("nextCursor")
                if not cursor:
                    break
            print(f"  {label}: {len(all_items)} MUs")
            for e in all_items:
                mid = e.get("mu")
                if mid:
                    mu_damage[side][mid] = float(e.get("value") or 0)

        # ── 5. MU names ───────────────────────────────────────
        mu_ids = set()
        for c in all_contracts:
            wmu = c.get("currentWinner")
            if wmu:
                mu_ids.add(wmu)
        mu_names = {}
        if mu_ids:
            mu_objs = await call_with_retry(
                lambda: client.mu.get_many(list(mu_ids))
            )
            for m in mu_objs:
                if m and m.id:
                    mu_names[m.id] = m.name or m.id
                elif m:
                    d = m.model_dump()
                    uid = d.get("_id") or d.get("id")
                    name = d.get("name") or uid
                    mu_names[uid] = name

        # ── 6. Compute costs per country ──────────────────────
        att_total_mu = sum(float(e.get("value") or 0) for e in mu_data["attacker"])
        def_total_mu = sum(float(e.get("value") or 0) for e in mu_data["defender"])

        def build_entry(c):
            side = c.get("forCountrySide")
            cost = float(c.get("currentPayout") or c.get("budget") or 0)
            winner_mu = c.get("currentWinner")
            min_dmg = float(c.get("minimumDamage") or 0)
            actual_dmg = mu_damage.get(side, {}).get(winner_mu, 0)
            return {
                "cost": cost,
                "mu_name": mu_names.get(winner_mu, winner_mu or "?"),
                "perK": c.get("currentPerK") or c.get("initialPerK") or 0,
                "minDamage": min_dmg,
                "actualDamage": actual_dmg,
                "completed": actual_dmg >= min_dmg,
                "round": c.get("roundNumber") or "?",
                "professionalsOnly": c.get("professionalsOnly", False),
            }

        all_entries = [build_entry(c) for c in all_contracts]
        att_completed = [e for e in all_entries if e.get("forCountrySide", e.get("side")) or (
            lambda e=e: (not e.get("_side") and (
                all_entries.index(e) < sum(1 for x in all_entries if x.get("forCountrySide", x.get("side")) == "attacker")
            )) 
        ) or True and False]

        # simpler: just rebuild with side set
        att_completed = []
        att_uncompleted = []
        def_completed = []
        def_uncompleted = []
        for c in all_contracts:
            e = build_entry(c)
            side = c.get("forCountrySide")
            if side == "attacker":
                if e["completed"]:
                    att_completed.append(e)
                else:
                    att_uncompleted.append(e)
            elif side == "defender":
                if e["completed"]:
                    def_completed.append(e)
                else:
                    def_uncompleted.append(e)

        att_contract_sum = sum(e["cost"] for e in att_completed)
        def_contract_sum = sum(e["cost"] for e in def_completed)
        att_bounties = att_total_mu - att_contract_sum
        def_bounties = def_total_mu - def_contract_sum

        # ── 7. Report ─────────────────────────────────────────
        out_lines = []

        def wl(line=""):
            out_lines.append(line)
            print(line)

        def print_contract(e):
            prof = "  [nur Profis]" if e["professionalsOnly"] else ""
            wl(f"      {e['mu_name']:30s} {e['cost']:>8.2f} btc  "
               f"({e['perK']:.2f}/1k, min {e['minDamage']:>7,}){prof}")

        def print_side(name, total, bounties, contract_sum, completed):
            wl()
            wl(f"  {name} — Gesamtkosten: {total:>10.2f} btc")
            wl(f"    Bounties:              {bounties:>10.2f} btc")
            wl(f"    Mercenary contracts:   {contract_sum:>10.2f} btc")
            for e in completed:
                print_contract(e)

        wl("=" * 70)
        wl(f"  COST REPORT — Battle {battle_id}")
        wl(f"  {att_name} (attacker) vs {def_name} (defender)")
        wl(f"  {created} — {att_region} / {def_region}")
        wl("=" * 70)

        print_side(att_name, att_total_mu, att_bounties, att_contract_sum, att_completed)
        print_side(def_name, def_total_mu, def_bounties, def_contract_sum, def_completed)

        # Save
        out_dir = script_dir / "data"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"battle_cost_{battle_id}.txt"
        out_path.write_text("\n".join(out_lines), encoding="utf-8")
        print(f"Report saved to {out_path}")


asyncio.run(main())
