let countriesData = [];
let countryMap = {};
let regionMap = {};

let currentMode = 'battle';
let battleResults = null;
let countryResults = null;
let isFetching = false;

function $(id) { return document.getElementById(id); }

// ─── Init ────────────────────────────────────────
async function init() {
  await Promise.all([loadCountries(), loadRegions()]);

  const savedToken = getApiKey();
  if (savedToken) {
    $('api-token').value = savedToken;
    updateTokenStatus(true);
  }

  setupBattleMode();
  setupCountryMode();
  setupLootMode();
  setupModeToggle();
  setupTokenInput();

  $('view-battle').classList.remove('hidden');
  loadRecentBattles();
}

// ─── Countries ───────────────────────────────────
async function loadCountries() {
  const select = $('country-select');
  select.innerHTML = '<option value="">Loading...</option>';

  try {
    const data = await Warera.getAllCountries();
    countriesData = Array.isArray(data) ? data : Object.values(data);
    if (!Array.isArray(countriesData)) {
      if (data.countries) {
        countriesData = Object.values(data.countries);
      } else if (typeof data === 'object') {
        countriesData = Object.entries(data).map(([id, c]) => ({ _id: id, name: c.name || id }));
      }
    }
  } catch {
    try {
      const res = await fetch('js/country-cache.json');
      const cache = await res.json();
      countriesData = Object.entries(cache).map(([id, name]) => ({ _id: id, name }));
    } catch {
      countriesData = [];
    }
  }

  countriesData.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  countryMap = {};
  select.innerHTML = '<option value="">— Select country —</option>';
  let germanyIdx = -1;
  for (let i = 0; i < countriesData.length; i++) {
    const c = countriesData[i];
    const id = c._id || c.id;
    const name = c.name || id;
    if (id) countryMap[id] = name;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    if (name === 'Germany' || id === '6813b6d446e731854c7ac79c') { opt.selected = true; germanyIdx = i; }
    select.appendChild(opt);
  }
}

// ─── Regions ─────────────────────────────────────
async function loadRegions() {
  try {
    const data = await Warera.getAllRegions();
    const regions = data.regions || data;
    if (typeof regions === 'object') {
      for (const [id, r] of Object.entries(regions)) {
        let code = r.code || '';
        code = code.replace(/^de-/, '').replace(/^dk-/, '');
        regionMap[id] = code.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || r.name || id;
      }
    }
  } catch { /* regions will be resolved on demand */ }
}

async function resolveRegionName(id) {
  if (!id) return '?';
  if (regionMap[id]) return regionMap[id];
  try {
    const r = await Warera.getRegionById(id);
    let code = r.code || '';
    code = code.replace(/^de-/, '').replace(/^dk-/, '');
    regionMap[id] = code.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || r.name || id;
    return regionMap[id];
  } catch { return id; }
}

// ─── Token ───────────────────────────────────────
function setupTokenInput() {
  $('api-token').addEventListener('change', () => {
    const val = $('api-token').value.trim();
    if (val) {
      setApiKey(val);
      updateTokenStatus(true);
      loadRecentBattles();
    } else {
      clearApiKey();
      updateTokenStatus(false);
    $('recent-battles-list').innerHTML = '<div class="text-dim" style="padding:8px;">Enter API token for current battles.</div>';
    }
  });
}

function updateTokenStatus(set) {
  const el = $('token-status');
  if (set) {
    el.innerHTML = '<span class="dot set"></span> Token set';
    el.style.color = 'var(--green)';
  } else {
    el.innerHTML = '<span class="dot unset"></span> No token';
    el.style.color = 'var(--red)';
  }
}

// ─── Mode Toggle ─────────────────────────────────
function setupModeToggle() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
      document.querySelectorAll('.mode-view').forEach(v => v.classList.add('hidden'));
      $(`view-${currentMode}`).classList.remove('hidden');
      $('recent-battles').classList.toggle('hidden', currentMode !== 'battle');
      ['battle-result', 'country-result', 'loot-result'].forEach(id => $(id).innerHTML = '');
    });
  });
}

// ─── Battle Mode ─────────────────────────────────
function setupBattleMode() {
  $('battle-fetch-btn').addEventListener('click', fetchBattleReport);
  $('battle-id').addEventListener('keydown', e => { if (e.key === 'Enter') fetchBattleReport(); });
}

// ─── Recent Top Battles ─────────────────────────
async function loadRecentBattles() {
  if (!getApiKey()) {
    $('recent-battles-list').innerHTML = '<div class="text-dim" style="padding:8px;">Enter API token for current battles.</div>';
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3);

  try {
    const battles = await Warera.getAllBattles({ limit: 50, direction: 'backward' }, cutoff);
    if (!battles.length) {
      $('recent-battles-list').innerHTML = '<div class="text-dim" style="padding:8px;">No battles in the last 3 days.</div>';
      return;
    }

    // Get details for top battles to find biggest by damage
    const withDamage = [];
    const batch = battles.slice(0, 25);
    for (let i = 0; i < batch.length; i++) {
      try {
        const b = await Warera.getBattleById(batch[i]._id);
        const att = b.attacker || {};
        const def = b.defender || {};
        const totalDmg = (att.damages || 0) + (def.damages || 0);
        withDamage.push({
          id: b._id,
          date: (b.createdAt || '').slice(0, 10),
          attCountry: att.country,
          defCountry: def.country,
          hitCount: (att.hitCount || 0) + (def.hitCount || 0),
          totalDamage: totalDmg,
          isActive: b.isActive || false,
          attRegion: att.region,
          defRegion: def.region,
        });
      } catch {}
    }

    withDamage.sort((a, b) => b.totalDamage - a.totalDamage || b.hitCount - a.hitCount);
    const top = withDamage.slice(0, 10);

    // Resolve country names
    for (const b of top) {
      b.attCountryName = countryMap[b.attCountry] || b.attCountry;
      b.defCountryName = countryMap[b.defCountry] || b.defCountry;
    }

    renderRecentBattles(top);
  } catch (err) {
    $('recent-battles-list').innerHTML = `<div class="text-dim" style="padding:8px;">Error loading: ${err.message}</div>`;
  }
}

function renderRecentBattles(list) {
  const listEl = $('recent-battles-list');
  listEl.innerHTML = '';

  for (const b of list) {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;gap:12px;padding:8px 10px;cursor:pointer;border-radius:4px;border-bottom:1px solid var(--border);transition:background 0.1s;';
    item.innerHTML = `
      <span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--text-dim);min-width:80px;">${b.date}</span>
      <span style="font-weight:600;font-size:0.85rem;flex:1;">${b.attCountryName} vs ${b.defCountryName}</span>
      <span style="font-family:var(--font-mono);font-size:0.8rem;color:${b.isActive ? 'var(--green)' : 'var(--orange)'};min-width:80px;text-align:right;">
        ${(b.totalDamage / 1e6).toFixed(1)}M dmg
      </span>
      ${b.isActive ? '<span style="font-size:0.7rem;color:var(--green);">●</span>' : ''}
      <span style="font-size:0.7rem;color:var(--text-dim);font-family:var(--font-mono);">${b.id.slice(0, 8)}</span>
    `;
    item.addEventListener('mouseenter', () => { item.style.background = 'var(--bg-hover)'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; });
    item.addEventListener('click', () => {
      $('battle-id').value = b.id;
      fetchBattleReport();
    });
    listEl.appendChild(item);
  }
}

async function fetchBattleReport() {
  const battleId = $('battle-id').value.trim();
  if (!battleId) return showError('battle-err', 'Please enter a Battle ID.');
  if (!getApiKey()) return showError('battle-err', 'Please enter your API token first.');

  isFetching = true;
  setFetchingState('battle', true);
  hideError('battle-err');
  $('empty-state').classList.add('hidden');
  $('battle-result').innerHTML = '<div class="loading"><div class="spinner"></div> Loading battle data...</div>';

  try {
    const result = await analyzeBattle(battleId);
    battleResults = result;
    renderBattleResult(result);
  } catch (err) {
    showError('battle-err', `Error: ${err.message}`);
    $('battle-result').innerHTML = '';
  } finally {
    isFetching = false;
    setFetchingState('battle', false);
  }
}

async function analyzeBattle(battleId) {
  const battle = await Warera.getBattleById(battleId);

  const attInfo = battle.attacker || {};
  const defInfo = battle.defender || {};
  const attCountryId = attInfo.country;
  const defCountryId = defInfo.country;
  const attRegionId = attInfo.region;
  const defRegionId = defInfo.region;

  if (attCountryId && !countryMap[attCountryId]) {
    try { const c = await Warera.getCountryById(attCountryId); countryMap[attCountryId] = c.name || attCountryId; } catch {}
  }
  if (defCountryId && !countryMap[defCountryId]) {
    try { const c = await Warera.getCountryById(defCountryId); countryMap[defCountryId] = c.name || defCountryId; } catch {}
  }
  const attCountry = countryMap[attCountryId] || attCountryId || '?';
  const defCountry = countryMap[defCountryId] || defCountryId || '?';
  const attRegion = await resolveRegionName(attRegionId);
  const defRegion = await resolveRegionName(defRegionId);

  const allContracts = await Warera.getAllContracts({
    battleId, status: 'won', limit: 50,
  });

  const [attMoney, defMoney, attDmg, defDmg] = await Promise.all([
    Warera.getAllRanking({ battleId, dataType: 'money', type: 'mu', side: 'attacker', limit: 100 }),
    Warera.getAllRanking({ battleId, dataType: 'money', type: 'mu', side: 'defender', limit: 100 }),
    Warera.getAllRanking({ battleId, dataType: 'damage', type: 'mu', side: 'attacker', limit: 100 }),
    Warera.getAllRanking({ battleId, dataType: 'damage', type: 'mu', side: 'defender', limit: 100 }),
  ]);

  const muDamage = { attacker: {}, defender: {} };
  for (const e of attDmg) { const mid = e.mu; if (mid) muDamage.attacker[mid] = parseFloat(e.value) || 0; }
  for (const e of defDmg) { const mid = e.mu; if (mid) muDamage.defender[mid] = parseFloat(e.value) || 0; }

  const muIds = [...new Set(allContracts.map(c => c.currentWinner).filter(Boolean))];
  const muNames = await resolveMuNames(muIds);

  function buildEntry(c) {
    const side = c.forCountrySide;
    const cost = parseFloat(c.currentPayout || c.budget || 0);
    const wmu = c.currentWinner;
    const minDmg = parseFloat(c.minimumDamage || 0);
    const actualDmg = (muDamage[side] || {})[wmu] || 0;
    return {
      cost,
      muName: muNames[wmu] || wmu || '?',
      perK: c.currentPerK || c.initialPerK || 0,
      minDamage: minDmg,
      actualDamage: actualDmg,
      completed: actualDmg >= minDmg,
      round: c.roundNumber || '?',
      professionalsOnly: c.professionalsOnly || false,
      side,
    };
  }

  const entries = allContracts.map(buildEntry);
  const attTotal = attMoney.reduce((s, e) => s + (parseFloat(e.value) || 0), 0);
  const defTotal = defMoney.reduce((s, e) => s + (parseFloat(e.value) || 0), 0);

  const attCompleted = entries.filter(e => e.side === 'attacker' && e.completed);
  const defCompleted = entries.filter(e => e.side === 'defender' && e.completed);
  const attContractSum = attCompleted.reduce((s, e) => s + e.cost, 0);
  const defContractSum = defCompleted.reduce((s, e) => s + e.cost, 0);

  return {
    id: battleId,
    date: (battle.createdAt || '').slice(0, 10),
    attCountryId, defCountryId,
    attCountry, defCountry,
    attRegion, defRegion,
    isActive: battle.isActive || false,
    attTotal, defTotal,
    attBounties: attTotal - attContractSum,
    defBounties: defTotal - defContractSum,
    attContractSum, defContractSum,
    attCompleted, defCompleted,
  };
}

async function resolveMuNames(ids) {
  const map = {};
  if (!ids.length) return map;
  const chunkSize = 5;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const results = await Promise.allSettled(chunk.map(id => Warera.getMuById(id)));
    for (let j = 0; j < chunk.length; j++) {
      const r = results[j];
      map[chunk[j]] = r.status === 'fulfilled' && r.value
        ? (r.value.name || r.value._id || r.value.id || chunk[j])
        : chunk[j];
    }
  }
  return map;
}

// ─── Render Battle ───────────────────────────────
function renderBattleResult(r) {
  const attColor = r.attTotal >= r.defTotal ? 'green' : 'red';
  const defColor = r.defTotal >= r.attTotal ? 'green' : 'red';

  $('battle-result').innerHTML = `
    <div class="battle-header">
      <div>
        <div class="battle-title">${r.attCountry} vs ${r.defCountry}</div>
        <div class="battle-meta">
          <span><strong>Date:</strong> ${r.date}</span>
          <span><strong>Region:</strong> ${r.attRegion} / ${r.defRegion}</span>
          <span><strong>ID:</strong> <code>${r.id}</code></span>
          ${r.isActive ? '<span style="color:var(--green)">● Active</span>' : ''}
        </div>
      </div>
    </div>

    <div class="dashboard-grid">
      ${statCard(r.attCountry + ' — Total', r.attTotal.toFixed(2), 'btc', attColor)}
      ${statCard(r.attCountry + ' — Bounties', r.attBounties.toFixed(2), 'btc', 'accent')}
      ${statCard(r.attCountry + ' — Contracts', r.attContractSum.toFixed(2), 'btc (' + r.attCompleted.length + ' units)', 'accent')}
      ${statCard(r.defCountry + ' — Total', r.defTotal.toFixed(2), 'btc', defColor)}
      ${statCard(r.defCountry + ' — Bounties', r.defBounties.toFixed(2), 'btc', 'purple')}
      ${statCard(r.defCountry + ' — Contracts', r.defContractSum.toFixed(2), 'btc (' + r.defCompleted.length + ' units)', 'purple')}
    </div>

    <div class="side-panels">
      ${renderSidePanel('attacker', r.attCountry, r.attTotal, r.attBounties, r.attContractSum, r.attCompleted)}
      ${renderSidePanel('defender', r.defCountry, r.defTotal, r.defBounties, r.defContractSum, r.defCompleted)}
    </div>
  `;
}

function statCard(label, value, unit, color) {
  return `
    <div class="dashboard-card">
      <div class="label">${label}</div>
      <div class="value ${color}">${value}</div>
      <div class="sub">${unit}</div>
    </div>
  `;
}

function renderSidePanel(side, name, total, bounties, contractSum, contracts) {
  const isAtt = side === 'attacker';
  const cls = isAtt ? 'attacker' : 'defender';
  const sideLabel = isAtt ? 'Attacker' : 'Defender';

  let rows = '';
  if (contracts.length) {
    for (const c of contracts) {
      rows += `<tr>
        <td class="mu-name">${c.muName}${c.professionalsOnly ? '<span class="pro-only">[Pro]</span>' : ''}</td>
        <td>${c.cost.toFixed(2)} btc</td>
        <td>${c.perK.toFixed(2)}</td>
        <td class="text-mono ${c.completed ? 'completed' : 'incomplete'}">${c.completed ? '✓' : '✗'}</td>
      </tr>`;
    }
  } else {
    rows = '<tr><td colspan="4" style="color:var(--text-dim);text-align:center;">No completed contracts</td></tr>';
  }

  return `
    <div class="side-panel">
      <div class="side-panel-header ${cls}">
        <span>${name} (${sideLabel})</span>
        <span style="font-family:var(--font-mono);font-size:0.85rem;">${total.toFixed(2)} btc</span>
      </div>
      <div class="side-panel-body">
        <div class="side-stat"><span class="label">Bounties</span><span class="value">${bounties.toFixed(2)} btc</span></div>
        <div class="side-stat"><span class="label">Contracts</span><span class="value">${contractSum.toFixed(2)} btc</span></div>
        <div class="side-stat"><span class="label">Count</span><span class="value">${contracts.length}</span></div>
      </div>
      ${contracts.length ? `
      <div class="table-wrap">
        <table class="contract-table">
          <thead><tr><th>MU</th><th>Cost</th><th>perK</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : ''}
    </div>
  `;
}

// ─── Country Mode ────────────────────────────────
function setupCountryMode() {
  $('country-fetch-btn').addEventListener('click', fetchCountryReport);
  setupDatePresets();
}

function setupDatePresets() {
  document.querySelectorAll('.date-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.date-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const days = parseInt(btn.dataset.days);
      if (days > 0) {
        const from = new Date();
        from.setDate(from.getDate() - days);
        $('country-date-from').value = from.toISOString().slice(0, 10);
        $('country-date-to').value = new Date().toISOString().slice(0, 10);
      }
    });
  });
  document.querySelector('.date-preset[data-days="5"]')?.click();
}

async function fetchCountryReport() {
  const countryId = $('country-select').value;
  if (!countryId) return showError('country-err', 'Please select a country.');

  const dateFrom = $('country-date-from').value;
  const dateTo = $('country-date-to').value;
  if (!dateFrom || !dateTo) return showError('country-err', 'Please select a time period.');
  if (!getApiKey()) return showError('country-err', 'Please enter your API token first.');

  isFetching = true;
  setFetchingState('country', true);
  hideError('country-err');
  $('empty-state').classList.add('hidden');

  const fromDate = new Date(dateFrom);
  const toDate = new Date(dateTo);
  toDate.setHours(23, 59, 59, 999);

  const countryName = countryMap[countryId] || countryId;
  setProgress('Loading battle list...', 0);

  try {
    const allBattles = await Warera.getAllBattles({
      countryId, limit: 50, direction: 'backward',
    }, fromDate);

    const filtered = allBattles.filter(b => {
      const created = new Date(b.createdAt || 0);
      return created >= fromDate && created <= toDate;
    });

    if (filtered.length === 0) {
      $('country-result').innerHTML = '<div class="empty-state"><p>No battles found in the selected period.</p></div>';
      isFetching = false;
      setFetchingState('country', false);
      hideProgress();
      return;
    }

    setProgress(`Analyzing ${filtered.length} battles...`, 0);
    const results = [];
    for (let i = 0; i < filtered.length; i++) {
      const b = filtered[i];
      const pct = Math.round(((i + 1) / filtered.length) * 100);
      setProgress(`Analyzing battle ${i + 1}/${filtered.length}...`, pct);
      try {
        const r = await analyzeBattle(b._id);
        if (r) results.push(r);
      } catch (err) {
        console.warn(`Battle ${b._id} fehlgeschlagen:`, err);
      }
    }

    if (results.length === 0) {
      $('country-result').innerHTML = '<div class="empty-state"><p>No battles could be analyzed.</p></div>';
      isFetching = false;
      setFetchingState('country', false);
      hideProgress();
      return;
    }

    countryResults = { countryId, countryName, dateFrom, dateTo, results };
    renderCountryReport(countryResults);
  } catch (err) {
    showError('country-err', `Fehler: ${err.message}`);
    $('country-result').innerHTML = '';
  } finally {
    isFetching = false;
    setFetchingState('country', false);
    hideProgress();
  }
}

function setProgress(text, pct) {
  const prog = $('country-progress');
  prog.classList.remove('hidden');
  $('prog-fill').style.width = `${pct}%`;
  $('prog-text').textContent = text;
}

function hideProgress() {
  $('country-progress').classList.add('hidden');
}

// ─── Render Country Report ───────────────────────
function renderCountryReport(r) {
  const { countryName, dateFrom, dateTo, results } = r;

  let ownBounties = 0, ownContracts = 0, ownTotal = 0;
  let oppBounties = 0, oppContracts = 0, oppTotal = 0;
  const ownContractsList = [];
  const oppContractsList = [];

  for (const res of results) {
    const isAtt = res.attCountryId === r.countryId;
    if (isAtt) {
      ownTotal += res.attTotal;
      ownBounties += res.attBounties;
      ownContracts += res.attContractSum;
      oppTotal += res.defTotal;
      oppBounties += res.defBounties;
      oppContracts += res.defContractSum;
      ownContractsList.push(...res.attCompleted);
      oppContractsList.push(...res.defCompleted);
    } else {
      ownTotal += res.defTotal;
      ownBounties += res.defBounties;
      ownContracts += res.defContractSum;
      oppTotal += res.attTotal;
      oppBounties += res.attBounties;
      oppContracts += res.attContractSum;
      ownContractsList.push(...res.defCompleted);
      oppContractsList.push(...res.attCompleted);
    }
  }

  ownContractsList.sort((a, b) => b.cost - a.cost);
  oppContractsList.sort((a, b) => b.cost - a.cost);

  const el = $('country-result');

  let html = `
    <div class="battle-header">
      <div>
        <div class="battle-title">${countryName} — Cost Report</div>
        <div class="battle-meta">
          <span><strong>Period:</strong> ${dateFrom} to ${dateTo}</span>
          <span><strong>Battles:</strong> ${results.length}</span>
        </div>
      </div>
    </div>

    <div class="dashboard-grid">
      ${statCard(countryName + ' — Total', ownTotal.toFixed(2), 'btc', 'green')}
      ${statCard('Bounties', ownBounties.toFixed(2), 'btc', 'accent')}
      ${statCard('Mercenary Contracts', ownContracts.toFixed(2), 'btc (' + ownContractsList.length + ' units)', 'accent')}
      ${statCard('Opponent — Total', oppTotal.toFixed(2), 'btc', 'red')}
      ${statCard('Opponent — Top Contract', oppContractsList.length ? oppContractsList[0].cost.toFixed(2) : '0.00', 'btc', 'purple')}
      ${statCard('Battles', results.length, 'in period', 'cyan')}
    </div>

    <div class="card">
      <div class="card-header">Summary</div>
      <div class="table-wrap">
        <table class="contract-table">
          <thead><tr>
            <th></th>
            <th style="text-align:right;">Bounties</th>
            <th style="text-align:right;">Contracts</th>
            <th style="text-align:right;">Gesamt</th>
          </tr></thead>
          <tbody>
            <tr>
              <td><strong>${countryName}</strong></td>
              <td style="text-align:right;">${ownBounties.toFixed(2)} btc</td>
              <td style="text-align:right;">${ownContracts.toFixed(2)} btc</td>
              <td style="text-align:right;"><strong>${ownTotal.toFixed(2)} btc</strong></td>
            </tr>
            <tr>
              <td><strong>Opponent</strong></td>
              <td style="text-align:right;">${oppBounties.toFixed(2)} btc</td>
              <td style="text-align:right;">${oppContracts.toFixed(2)} btc</td>
              <td style="text-align:right;"><strong>${oppTotal.toFixed(2)} btc</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Battle List (${results.length})</div>
      ${results.map(res => renderBattleListItem(res, r.countryId)).join('')}
    </div>

    ${renderTopContracts('Own Top Contracts', ownContractsList, countryName)}
    ${renderTopContracts('Opponent Top Contracts', oppContractsList, 'Opponent')}
  `;

  el.innerHTML = html;

  el.querySelectorAll('.battle-list-item').forEach(item => {
    item.addEventListener('click', () => item.classList.toggle('expanded'));
  });
}

function renderBattleListItem(res, ownCountryId) {
  const isAtt = res.attCountryId === ownCountryId;
  const ownTotal = isAtt ? res.attTotal : res.defTotal;
  const region = `${res.attRegion} / ${res.defRegion}`;

  const ownStat = isAtt
    ? `B: ${res.attBounties.toFixed(1)} / C: ${res.attContractSum.toFixed(1)}`
    : `B: ${res.defBounties.toFixed(1)} / C: ${res.defContractSum.toFixed(1)}`;

  const attRows = res.attCompleted.map(c => `<tr>
    <td class="mu-name">${c.muName}${c.professionalsOnly ? '<span class="pro-only">[Pro]</span>' : ''}</td>
    <td class="text-mono">${c.cost.toFixed(2)} btc</td>
    <td class="text-mono">${c.perK.toFixed(2)}</td>
    <td class="text-mono ${c.completed ? 'completed' : 'incomplete'}">${c.minDamage.toLocaleString()} / ${c.actualDamage.toLocaleString()}</td>
  </tr>`).join('');

  const defRows = res.defCompleted.map(c => `<tr>
    <td class="mu-name">${c.muName}</td>
    <td>${c.cost.toFixed(2)} btc</td>
    <td>${c.perK.toFixed(2)}</td>
  </tr>`).join('');

  return `
    <div class="battle-list-item">
      <div class="summary">
        <div class="summary-left">
          <span class="date">${res.date}</span>
          <span class="vs">${res.attCountry} vs ${res.defCountry}</span>
          <span class="region">${region}</span>
          <span class="text-dim text-sm">${ownStat}</span>
        </div>
        <span class="total-cost" style="color:${ownTotal > 0 ? 'var(--green)' : 'var(--text-dim)'}">
          ${ownTotal.toFixed(2)} btc
        </span>
      </div>
      <div class="battle-detail">
        <div class="side-panels" style="margin-top:0;">
          <div class="side-panel">
            <div class="side-panel-header attacker">
              <span>${res.attCountry} <span class="text-dim">(${(isAtt ? 'own' : 'opp')})</span></span>
              <span style="font-family:var(--font-mono);font-size:0.85rem;">${res.attTotal.toFixed(2)} btc</span>
            </div>
            <div class="side-panel-body">
              <div class="side-stat"><span class="label">Bounties</span><span class="value">${res.attBounties.toFixed(2)} btc</span></div>
              <div class="side-stat"><span class="label">Contracts</span><span class="value">${res.attContractSum.toFixed(2)} btc</span></div>
          </div>
          ${attRows ? '<div class="table-wrap"><table class="contract-table"><thead><tr><th>MU</th><th>Cost</th><th>perK</th><th>Damage</th></tr></thead><tbody>' + attRows + '</tbody></table></div>' : ''}
        </div>
        <div class="side-panel">
          <div class="side-panel-header defender">
            <span>${res.defCountry} <span class="text-dim">(${(isAtt ? 'opp' : 'own')})</span></span>
            <span style="font-family:var(--font-mono);font-size:0.85rem;">${res.defTotal.toFixed(2)} btc</span>
          </div>
          <div class="side-panel-body">
            <div class="side-stat"><span class="label">Bounties</span><span class="value">${res.defBounties.toFixed(2)} btc</span></div>
            <div class="side-stat"><span class="label">Contracts</span><span class="value">${res.defContractSum.toFixed(2)} btc</span></div>
            </div>
            ${defRows ? '<div class="table-wrap"><table class="contract-table"><thead><tr><th>MU</th><th>Cost</th><th>perK</th><th>Damage</th></tr></thead><tbody>' + defRows + '</tbody></table></div>' : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderTopContracts(title, contracts) {
  if (!contracts.length) return '';
  const top = contracts.slice(0, 20);
  const rows = top.map((c, i) => `<tr>
    <td>${i + 1}</td>
    <td class="mu-name">${c.muName}${c.professionalsOnly ? '<span class="pro-only">[Pro]</span>' : ''}</td>
    <td style="text-align:right;">${c.cost.toFixed(2)} btc</td>
    <td style="text-align:right;">${c.perK.toFixed(2)}</td>
    <td style="text-align:right;">${c.minDamage.toLocaleString()}</td>
    <td class="${c.completed ? 'completed' : 'incomplete'}">${c.completed ? '✓' : '✗'}</td>
  </tr>`).join('');

  return `
    <div class="card">
      <div class="card-header">${title}</div>
      <div class="table-wrap">
        <table class="contract-table">
          <thead><tr>
            <th>#</th>
            <th>MU</th>
            <th style="text-align:right;">Cost</th>
            <th style="text-align:right;">perK</th>
            <th style="text-align:right;">Min Damage</th>
            <th>Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

// ─── Loot Mode ──────────────────────────────────
function setupLootMode() {
  $('loot-fetch-btn').addEventListener('click', fetchLootBreakPoints);
  $('loot-user-id').addEventListener('keydown', e => { if (e.key === 'Enter') fetchLootBreakPoints(); });
}

function getTierFromCode(code) {
  if (!code || code === 'no-loot') return 0;
  const named = { knife: 1, pistol: 2, gun: 2, rifle: 3, sniper: 4, tank: 5, jet: 6 };
  if (named[code] !== undefined) return named[code];
  const m = code.match(/(\d+)$/);
  return m ? parseInt(m[1]) : 0;
}

const TIER_RARITY = ['None', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];

async function fetchLootBreakPoints() {
  const userId = $('loot-user-id').value.trim();
  const dmgInput = $('loot-damage').value.trim();
  const projectedDamage = dmgInput ? parseFloat(dmgInput) * 1000 : null;
  if (!getApiKey()) return showError('loot-err', 'Please enter your API token first.');

  setFetchingState('loot', true);
  hideError('loot-err');

  try {
    let userName = '';
    if (userId) {
      userName = userId;
      try {
        const user = await Warera.getUserLite(userId);
        userName = user.username || user.name || userId;
      } catch {}
    }

    $('loot-result').innerHTML = '<div class="loading"><div class="spinner"></div> Loading active battles...</div>';

    const battles = [];
    let cursor = null;
    while (true) {
      const params = { isActive: true, limit: 50 };
      if (cursor) params.cursor = cursor;
      const data = await Warera.getBattles(params);
      const items = data.items || [];
      battles.push(...items);
      cursor = data.nextCursor;
      if (!cursor || !items.length) break;
    }
    if (!battles.length) {
      $('loot-result').innerHTML = '<div class="empty-state"><p>No active battles found.</p></div>';
      return;
    }

    $('loot-result').innerHTML = '<div class="loading"><div class="spinner"></div> Analyzing battles...</div>';

    const priceData = await Warera.getItemPrices();
    const scrapPrice = Number(priceData?.scraps) || 0;
    const steelPrice = Number(priceData?.steel) || 0;
    const craftCost = {
      1: scrapPrice * 6 + steelPrice * 1,
      2: scrapPrice * 18 + steelPrice * 1,
      3: scrapPrice * 54 + steelPrice * 4,
      4: scrapPrice * 162 + steelPrice * 8,
      5: scrapPrice * 486 + steelPrice * 16,
      6: scrapPrice * 1460 + steelPrice * 32,
    };

    const results = await Promise.all(battles.map(async (battle) => {
      const roundId = battle.rounds?.[battle.rounds.length - 1];
      if (!roundId) return null;

      const attCountry = countryMap[battle.attacker?.country] || battle.attacker?.country?.slice(0, 8) || '?';
      const defCountry = countryMap[battle.defender?.country] || battle.defender?.country?.slice(0, 8) || '?';
      if (attCountry === '?' && defCountry === '?') return null;
      const roundNum = battle.rounds?.length || null;
      const battleAge = battle.createdAt ? Date.now() - new Date(battle.createdAt).getTime() : 0;

      const entries = [];
      let cursor = null;
      let foundUser = false;
      let pages = 0;

      while (!foundUser && pages < 20) {
        pages++;
        const params = { roundId, dataType: 'damage', side: 'merged', type: 'user', limit: 100 };
        if (cursor) params.cursor = cursor;

        const rankingData = await Warera.getRanking(params);
        const items = rankingData.items || [];

        for (const item of items) {
          entries.push(item);
          if (userId && item.user === userId) { foundUser = true; break; }
        }

        cursor = rankingData.nextCursor;
        if (!cursor || !items.length) break;
      }

      entries.sort((a, b) => a.rank - b.rank);
      const userEntry = userId ? entries.find(e => e.user === userId) : null;

      return {
        battleId: battle._id,
        title: `${attCountry} vs ${defCountry}`,
        roundId: roundId.slice(0, 8),
        roundNum,
        battleAge,
        entries,
        userEntry,
      };
    }));

    let filteredResults = results.filter(Boolean);

    if (projectedDamage) {
      for (const r of filteredResults) {
        const existingDmg = r.userEntry?.value || 0;
        const totalDmg = existingDmg + projectedDamage;
        const tierMin = computeBreakPoints(r.entries);
        let projTier = 0;
        let projDmg = 0;
        for (let t = 6; t >= 1; t--) {
          if (tierMin[t] && totalDmg >= tierMin[t].damage) {
            projTier = t;
            projDmg = tierMin[t].damage;
            break;
          }
        }
        const price = craftCost[projTier] || 0;
        r.projectedTier = projTier;
        r.existingDmg = existingDmg;
        r.projectedBtcPer1k = price && projDmg ? (price / projDmg * 1000) : 0;
      }
      filteredResults.sort((a, b) => b.projectedBtcPer1k - a.projectedBtcPer1k);
    }

    renderLootResult(filteredResults, userId, userName, { scrapPrice, steelPrice, craftCost }, projectedDamage);
  } catch (err) {
    showError('loot-err', `Error: ${err.message}`);
    $('loot-result').innerHTML = '';
  } finally {
    setFetchingState('loot', false);
  }
}

function computeBreakPoints(entries) {
  const tierMin = {};
  for (const e of entries) {
    const code = e.lootItem?.code;
    if (!code || code === 'no-loot') continue;
    const tier = getTierFromCode(code);
    if (tier === 0) continue;
    if (!tierMin[tier] || e.value < tierMin[tier].damage) {
      tierMin[tier] = { damage: e.value, item: code, rank: e.rank };
    }
  }
  return tierMin;
}

function renderLootResult(results, userId, userName, pricesObj, projectedDamage) {
  const { scrapPrice, steelPrice, craftCost: tierPrices } = pricesObj || {};
  const el = $('loot-result');

  if (results.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No active rounds found.</p></div>';
    return;
  }

  let html = '';
  if (userId) {
    html = `<div class="card" style="margin-bottom:8px;">
      <div class="battle-title" style="font-size:0.95rem;">User: ${userName} <span class="text-dim" style="font-family:var(--font-mono);font-weight:400;font-size:0.8rem;">${userId.slice(0, 12)}</span></div>
    </div>`;
  }

  for (const r of results) {
    const { title, roundId, roundNum, battleAge, userEntry, projectedTier } = r;
    const tierMin = computeBreakPoints(r.entries);

    const userTier = userEntry ? getTierFromCode(userEntry.lootItem?.code) : 0;
    const userDmg = userId ? userEntry?.value : 0;

    const tiers = Object.keys(tierMin).map(Number).sort((a, b) => b - a);

    let tableRows = '';
    for (const tier of tiers) {
      const info = tierMin[tier];
      const reached = userDmg != null && info.damage <= userDmg;
      const delta = (reached || userDmg == null) ? null : info.damage - userDmg;

      const price = tierPrices?.[tier] || 0;
      const btcPer1k = price ? (price / info.damage * 1000) : null;
      const craft = { 1: {s:6,st:1}, 2: {s:18,st:1}, 3: {s:54,st:4}, 4: {s:162,st:8}, 5: {s:486,st:16}, 6: {s:1460,st:32} }[tier];
      const tooltip = price && craft
        ? `${craft.s} scrap × ${scrapPrice.toFixed(3)} + ${craft.st} steel × ${steelPrice.toFixed(3)} = ${price.toFixed(3)} BTC`
        : '';

      const rowClass = projectedTier === tier ? ' class="loot-projected-row"' : '';

      tableRows += `<tr${rowClass}>
        <td><span class="tier-badge tier-${tier}"${tooltip ? ` title="${tooltip}"` : ''}>${TIER_RARITY[tier]}</span></td>
        <td class="text-mono">${info.damage.toLocaleString()}</td>
        <td style="font-size:0.8rem;color:var(--text-dim);">#${info.rank}</td>
        <td class="text-mono" style="${reached ? 'color:var(--green);' : 'color:var(--orange);'}">${reached ? '✓' : (delta != null ? '+' + delta.toLocaleString() : '—')}</td>
        <td class="text-mono" style="font-size:0.75rem;">${btcPer1k != null ? btcPer1k.toFixed(3) : '—'}</td>
      </tr>`;
    }

    if (!tableRows) {
      tableRows = '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:20px;">No loot items in this round.</td></tr>';
    }

    let lootInfo;
    if (userId && projectedDamage) {
      const existingDmg = r.existingDmg || 0;
      const totalDmg = existingDmg + projectedDamage;
      lootInfo = `<span><strong>Rank #${userEntry?.rank || '?'}</strong> — ${existingDmg.toLocaleString()} + ${projectedDamage.toLocaleString()} = ${totalDmg.toLocaleString()} → <strong>${TIER_RARITY[projectedTier] || 'None'}</strong> (${(tierPrices?.[projectedTier] || 0).toFixed(3)} BTC)</span>`;
    } else if (userId && userEntry) {
      lootInfo = userTier > 0
        ? `<span><strong>Rank #${userEntry.rank}</strong> — ${userDmg.toLocaleString()} Damage — Item: <strong>${userEntry.lootItem.code}</strong> (${TIER_RARITY[userTier]})</span>`
        : `<span><strong>Rank #${userEntry.rank}</strong> — ${userDmg.toLocaleString()} Damage — <span style="color:var(--orange);">No loot</span></span>`;
    } else if (userId && !userEntry) {
      lootInfo = '<span style="color:var(--orange);">Not in this round\'s ranking</span>';
    } else if (projectedDamage) {
      lootInfo = `<span>Est. <strong>${projectedDamage.toLocaleString()}</strong> damage → <strong>${TIER_RARITY[projectedTier] || 'None'}</strong> (${(tierPrices?.[projectedTier] || 0).toFixed(3)} BTC)</span>`;
    } else {
      lootInfo = '';
    }

    html += `<div class="card">
      <div class="battle-header" style="margin-bottom:12px;">
        <div>
          <div class="battle-title">${title}</div>
          <div class="battle-meta">
            <span>${formatDuration(battleAge)} · Round ${roundNum ?? '?'} <span class="text-dim" style="font-family:var(--font-mono);font-size:0.75rem;">${roundId}</span></span>
            ${lootInfo}
          </div>
        </div>
      </div>
      <div class="table-wrap">
        <table class="contract-table">
          <thead><tr>
            <th>Tier</th>
            <th>Min. Damage</th>
            <th>Rank</th>
            <th>Status</th>
            <th>BTC/1k</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>`;
  }

  el.innerHTML = html;
}

// ─── Helpers ─────────────────────────────────────
function showError(id, msg) {
  const el = $(id);
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

function hideError(id) {
  const el = $(id);
  if (el) el.classList.add('hidden');
}

function formatDuration(ms) {
  if (ms <= 0) return '';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return '<1m';
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function setFetchingState(mode, fetching) {
  const labels = { battle: 'Abrufen', country: 'Report erstellen', loot: 'Search Battles' };
  const btn = mode === 'battle' ? $('battle-fetch-btn') : mode === 'country' ? $('country-fetch-btn') : $('loot-fetch-btn');
  if (btn) {
    btn.disabled = fetching;
    btn.textContent = fetching ? 'Loading...' : (labels[mode] || 'Fetch');
  }
}

document.addEventListener('DOMContentLoaded', init);
