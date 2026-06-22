#!/usr/bin/env python3
import asyncio
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from dotenv import load_dotenv
from warera import WareraClient

script_dir = Path(__file__).parent
load_dotenv(script_dir.parent / ".env")

# ── Config ────────────────────────────────────────────────────
COUNTRY_ID = "6813b6d446e731854c7ac79c"
COUNTRY_LABEL = "Germany"
DAYS_BACK = 5
# ──────────────────────────────────────────────────────────────


import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from lib.ratelimiter import call_with_retry


def extract_items(response):
    if not response:
        return []
    if isinstance(response, list):
        return response
    if isinstance(response, dict):
        for key in ("rankings", "items", "data", "results"):
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


async def analyze_battle(client, battle_id, mu_names):
    """Returns dict with cost analysis for one battle, or None on error."""
    try:
        battle = await call_with_retry(
            lambda: client._http.get("battle.getById", {"battleId": battle_id})
        )
    except Exception as e:
        print(f"  ERROR fetching battle {battle_id}: {e}", flush=True)
        return None

    att_info = battle.get("attacker") or {}
    def_info = battle.get("defender") or {}
    att_country_id = att_info.get("country")
    def_country_id = def_info.get("country")
    att_name = mu_names.get("_countries", {}).get(att_country_id, att_country_id)
    def_name = mu_names.get("_countries", {}).get(def_country_id, def_country_id)
    created = battle.get("createdAt", "")[:10]

    att_region_id = att_info.get("region")
    def_region_id = def_info.get("region")
    att_region = mu_names.get("_regions", {}).get(att_region_id, att_region_id or "?")
    def_region = mu_names.get("_regions", {}).get(def_region_id, def_region_id or "?")

    # Mercenary contracts
    all_contracts = []
    try:
        cursor = None
        while True:
            params = {
                "battleId": battle_id, "status": "won", "limit": 50,
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
    except Exception as e:
        print(f"  ERROR contracts for {battle_id}: {e}", flush=True)
        return None

    # MU money ranking (paginated)
    mu_data = {}
    for side in ("attacker", "defender"):
        all_items = []
        try:
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
        except Exception:
            pass
        mu_data[side] = all_items

    # MU damage ranking (paginated)
    mu_damage = {"attacker": {}, "defender": {}}
    for side in ("attacker", "defender"):
        try:
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
                for e in items:
                    mid = e.get("mu")
                    if mid:
                        mu_damage[side][mid] = float(e.get("value") or 0)
                cursor = raw.get("nextCursor")
                if not cursor:
                    break
        except Exception:
            pass

    att_total = sum(float(e.get("value") or 0) for e in mu_data["attacker"])
    def_total = sum(float(e.get("value") or 0) for e in mu_data["defender"])

    # Build contract entries
    def build_entry(c):
        s = c.get("forCountrySide")
        cost = float(c.get("currentPayout") or c.get("budget") or 0)
        wmu = c.get("currentWinner")
        min_dmg = float(c.get("minimumDamage") or 0)
        actual_dmg = mu_damage.get(s, {}).get(wmu, 0)
        return {
            "cost": cost,
            "mu_name": mu_names.get(wmu, wmu or "?"),
            "perK": c.get("currentPerK") or c.get("initialPerK") or 0,
            "minDamage": min_dmg,
            "completed": actual_dmg >= min_dmg,
            "professionalsOnly": c.get("professionalsOnly", False),
            "side": s,
        }

    entries = [build_entry(c) for c in all_contracts]
    att_completed = [e for e in entries if e["side"] == "attacker" and e["completed"]]
    def_completed = [e for e in entries if e["side"] == "defender" and e["completed"]]

    att_contract_sum = sum(e["cost"] for e in att_completed)
    def_contract_sum = sum(e["cost"] for e in def_completed)

    return {
        "id": battle_id,
        "date": created,
        "att_country": att_country_id,
        "def_country": def_country_id,
        "att_name": att_name,
        "def_name": def_name,
        "att_region": att_region,
        "def_region": def_region,
        "att_total": att_total,
        "def_total": def_total,
        "att_bounties": att_total - att_contract_sum,
        "def_bounties": def_total - def_contract_sum,
        "att_contracts": att_completed,
        "def_contracts": def_completed,
        "att_contract_sum": att_contract_sum,
        "def_contract_sum": def_contract_sum,
    }


async def main():
    api_key = os.environ.get("WARERA_API_KEY")
    if not api_key:
        print("ERROR: WARERA_API_KEY not set!")
        sys.exit(1)

    cutoff = datetime.now(timezone.utc) - timedelta(days=DAYS_BACK)
    print(f"Country cost report for: {COUNTRY_LABEL} ({COUNTRY_ID})")
    print(f"Looking back {DAYS_BACK} days (since {cutoff.date()})")
    print()

    async with WareraClient(api_key=api_key) as client:
        # ── 1. Find battles ────────────────────────────────────
        print("Finding battles...", flush=True)
        battle_ids = []
        cursor = None
        done = False
        while not done:
            page = await call_with_retry(
                lambda c=cursor: client.battle.get_many(
                    country_id=COUNTRY_ID, limit=50,
                    cursor=c if c else None,
                    direction="backward" if c else None,
                )
            )
            for b in page.items:
                raw = b.model_dump()
                created_raw = raw.get("createdAt")
                if created_raw:
                    dt = datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
                    if dt < cutoff:
                        done = True
                        break
                    battle_ids.append((b.id, created_raw[:10]))

            if not done and page.has_more and page.next_cursor:
                cursor = page.next_cursor
            else:
                break

        print(f"  Found {len(battle_ids)} battles in the last {DAYS_BACK} days")
        for bid, bdate in battle_ids:
            print(f"    {bid[:20]:20s} {bdate}")
        print()

        if not battle_ids:
            print("No battles found.")
            return

        # ── 2. Collect names (countries, regions, MUs) ─────────
        print("Collecting country/region/MU names...", flush=True)

        # Country names for all involved
        country_ids = set()
        region_ids = set()
        for bid, _ in battle_ids:
            try:
                battle = await call_with_retry(
                    lambda b=bid: client._http.get("battle.getById", {"battleId": b})
                )
                att_info = battle.get("attacker") or {}
                def_info = battle.get("defender") or {}
                country_ids.add(att_info.get("country"))
                country_ids.add(def_info.get("country"))
                region_ids.add(att_info.get("region"))
                region_ids.add(def_info.get("region"))
            except Exception:
                pass

        mu_names = {"_countries": {}, "_regions": {}}
        for cid in country_ids:
            if cid:
                mu_names["_countries"][cid] = await get_country_name(client, cid)
        for rid in region_ids:
            if rid:
                mu_names["_regions"][rid] = await get_region_name(client, rid)

        # ── 3. Analyze each battle ────────────────────────────
        print(f"Analyzing {len(battle_ids)} battles...", flush=True)
        results = []
        all_mu_ids = set()

        for bid, bdate in battle_ids:
            print(f"  {bdate} {bid[:12]}...", flush=True)
            result = await analyze_battle(client, bid, mu_names)
            if result:
                results.append(result)
                for c in result["att_contracts"]:
                    wmu = next(
                        (c2.get("mu_name") for c2 in [c] if c2.get("mu_name") != "?"),
                        None
                    )
                # Actually just collect the MU names we already have
                for entry in result["att_contracts"] + result["def_contracts"]:
                    pass  # names are already resolved

        # ── 4. Collect MU names for all contracts ──────────────
        # We need to collect MU IDs from all contracts
        print("Resolving MU names...", flush=True)
        mu_id_set = set()
        # Re-fetch contracts for MU IDs since we didn't store them
        # Better: redo MU name collection from the raw contract data
        for bid, _ in battle_ids:
            try:
                cursor = None
                while True:
                    params = {
                        "battleId": bid, "status": "won", "limit": 50,
                    }
                    if cursor:
                        params["cursor"] = cursor
                    merc_raw = await call_with_retry(
                        lambda p=params.copy(): client._http.get("mercenaryContractAuction.getPaginatedAuctions", p)
                    )
                    items = extract_items(merc_raw)
                    if not items:
                        break
                    for c in items:
                        wmu = c.get("currentWinner")
                        if wmu:
                            mu_id_set.add(wmu)
                    cursor = merc_raw.get("nextCursor")
                    if not cursor:
                        break
            except Exception:
                pass

        mu_name_map = {}
        if mu_id_set:
            mu_objs = await call_with_retry(
                lambda: client.mu.get_many(list(mu_id_set))
            )
            for m in mu_objs:
                if m and m.id:
                    mu_name_map[m.id] = m.name or m.id
                elif m:
                    d = m.model_dump()
                    uid = d.get("_id") or d.get("id")
                    name = d.get("name") or uid
                    mu_name_map[uid] = name
            mu_names.update(mu_name_map)

        # ── 5. Re-run analysis with proper MU names ────────────
        print("Re-analyzing with MU names...", flush=True)
        results = []
        for bid, bdate in battle_ids:
            result = await analyze_battle(client, bid, mu_names)
            if result:
                results.append(result)

        # ── 6. Output ──────────────────────────────────────────
        out_lines = []
        def wl(line=""):
            out_lines.append(line)
            print(line)

        wl("=" * 70)
        wl(f"  COST REPORT — {COUNTRY_LABEL} — Last {DAYS_BACK} days")
        wl(f"  {cutoff.date()} to {datetime.now(timezone.utc).date()}")
        wl("=" * 70)
        wl()

        # Per-battle compact list
        for r in results:
            is_att = r["att_country"] == COUNTRY_ID
            own_bounties = r["att_bounties"] if is_att else r["def_bounties"]
            own_contracts = r["att_contract_sum"] if is_att else r["def_contract_sum"]
            own_total = r["att_total"] if is_att else r["def_total"]
            opp_bounties = r["def_bounties"] if is_att else r["att_bounties"]
            opp_contracts = r["def_contract_sum"] if is_att else r["att_contract_sum"]
            opp_total = r["def_total"] if is_att else r["att_total"]
            opp_label = r["def_name"] if is_att else r["att_name"]
            region_label = f"{r['att_region']} / {r['def_region']}"

            wl(f"  {r['id'][:12]}  | {r['date']}  | {region_label}")
            wl(f"    {r['att_name']} vs {r['def_name']}")
            wl(f"    {COUNTRY_LABEL}: {own_total:>10.2f} btc  "
               f"(B: {own_bounties:>8.2f} / C: {own_contracts:>8.2f})")
            wl(f"    {opp_label}: {opp_total:>10.2f} btc  "
               f"(B: {opp_bounties:>8.2f} / C: {opp_contracts:>8.2f})")
            wl()

        # ── 7. Summary ─────────────────────────────────────────
        wl("═" * 70)
        wl(f"  SUMMARY — {COUNTRY_LABEL} — Last {DAYS_BACK} days")
        wl("═" * 70)
        wl()

        # Aggregate own contracts
        own_all_contracts = []
        opp_all_contracts = []
        own_total_bounties = 0.0
        own_total_contracts = 0.0
        own_total_all = 0.0
        opp_total_bounties = 0.0
        opp_total_contracts = 0.0
        opp_total_all = 0.0

        for r in results:
            is_att = r["att_country"] == COUNTRY_ID
            if is_att:
                own_total_all += r["att_total"]
                own_total_bounties += r["att_bounties"]
                own_total_contracts += r["att_contract_sum"]
                opp_total_all += r["def_total"]
                opp_total_bounties += r["def_bounties"]
                opp_total_contracts += r["def_contract_sum"]
                own_all_contracts.extend(r["att_contracts"])
                opp_all_contracts.extend(r["def_contracts"])
            else:
                own_total_all += r["def_total"]
                own_total_bounties += r["def_bounties"]
                own_total_contracts += r["def_contract_sum"]
                opp_total_all += r["att_total"]
                opp_total_bounties += r["att_bounties"]
                opp_total_contracts += r["att_contract_sum"]
                own_all_contracts.extend(r["def_contracts"])
                opp_all_contracts.extend(r["att_contracts"])

        def print_contract_list(contracts, total, bounties, label):
            sorted_c = sorted(contracts, key=lambda x: x["cost"], reverse=True)
            contract_sum = sum(c["cost"] for c in contracts)
            wl(f"  {label} — Gesamtkosten: {total:>10.2f} btc")
            wl(f"    Bounties:              {bounties:>10.2f} btc")
            wl(f"    Mercenary contracts:   {contract_sum:>10.2f} btc")
            for e in sorted_c:
                prof = "  [nur Profis]" if e["professionalsOnly"] else ""
                wl(f"      {e['mu_name']:30s} {e['cost']:>8.2f} btc  "
                   f"({e['perK']:.2f}/1k, min {e['minDamage']:>7,.0f}){prof}")
            wl()

        print_contract_list(own_all_contracts, own_total_all, own_total_bounties, COUNTRY_LABEL)
        print_contract_list(opp_all_contracts, opp_total_all, opp_total_bounties, "Opponents")

        # Summary table
        opp_label = "Opponents"
        wl(f"  {'─' * 50}")
        wl(f"  {'':>25} {COUNTRY_LABEL:>20} {opp_label:>20}")
        wl(f"  {'Bounties':>25} {own_total_bounties:>20.2f} {opp_total_bounties:>20.2f}")
        wl(f"  {'Contracts':>25} {own_total_contracts:>20.2f} {opp_total_contracts:>20.2f}")
        wl(f"  {'─' * 50}")
        wl(f"  {'Gesamt':>25} {own_total_all:>20.2f} {opp_total_all:>20.2f}")
        wl()

        # Save
        out_dir = script_dir / "data"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"country_cost_{COUNTRY_LABEL.lower()}_{DAYS_BACK}d.txt"
        out_path.write_text("\n".join(out_lines), encoding="utf-8")
        print(f"Report saved to {out_path}")


asyncio.run(main())
