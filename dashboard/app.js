// Token Radar dashboard: reads window.RADAR (data.js, written by main.ts),
// renders the ranked board, filters, sort and a per-protocol detail dialog.
// No network: every number on screen comes from the snapshot via data.js.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;

  var state = { q: '', category: 'all', chain: 'all', status: 'pre', sort: 'implied', selected: null };
  var $ = function (id) { return document.getElementById(id); };

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.round(d) + 'd';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // The model, recomputed in the page from the snapshot figures, so the
  // number the dialog shows can be checked against board.json's number.
  function impliedOf(r) {
    var m = DATA.model;
    var growth = Math.min(m.growthCap, Math.max(m.growthFloor, r.change_7d === null ? 0 : r.change_7d));
    var growthMult = 1 + (growth / 100) * m.growthWeight;
    var age = r.age_days === null ? m.unknownAgeDays : r.age_days;
    var maturity = m.maturityFloor + (Math.min(Math.max(age, 0), m.maturityDays) / m.maturityDays) * m.maturityRange;
    var chains = Math.max(0, Math.min((r.chains || []).length - 1, m.chainMax));
    return Math.max(1, Math.round(r.tvl_usd * r.model.base_multiple * growthMult * maturity * (1 + chains * m.chainStep)));
  }

  function readHash() {
    var p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (p.get('q')) state.q = p.get('q');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('status')) state.status = p.get('status');
    if (p.get('p')) state.selected = p.get('p');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.status !== 'pre') p.set('status', state.status);
    if (state.selected) p.set('p', state.selected);
    var s = p.toString();
    history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var list = state.status === 'live' ? DATA.live.map(function (r, i) {
      return { rank: i + 1, slug: r.slug, name: r.name, category: r.category, chains: r.chains,
        tvl_usd: r.tvl_usd, change_7d: r.change_7d, age_days: null, implied_value_usd: r.mcap_usd,
        watchlist: false, live: true, model: null, farm_steps: null };
    }) : DATA.rows.filter(function (r) { return state.status !== 'watch' || r.watchlist; });
    return list.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var dir = state.sort === 'name' ? 1 : -1;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (state.sort === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (state.sort === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (state.sort === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (state.sort === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else { av = a.implied_value_usd || 0; bv = b.implied_value_usd || 0; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  function renderStats() {
    $('stats').innerHTML =
      '<div><dt>Watchlist covered</dt><dd>' + DATA.watchlist_size + ' / ' + DATA.watchlist_size + '</dd></div>' +
      '<div><dt>Pre-token rows</dt><dd>' + DATA.board_size + '</dd></div>' +
      '<div><dt>Early rows</dt><dd>' + DATA.early_size + '</dd></div>' +
      '<div><dt>Live tokens set aside</dt><dd>' + DATA.live_size + '</dd></div>';
    var m = DATA.model;
    $('formula').textContent = 'implied = round( tvl_usd x categoryMultiple x (1 + clamp(change_7d, '
      + m.growthFloor + ', ' + m.growthCap + ') / 100 x ' + m.growthWeight + ') x ('
      + m.maturityFloor + ' + min(age_days, ' + m.maturityDays + ') / ' + m.maturityDays + ' x '
      + m.maturityRange + ') x (1 + min(chains - 1, ' + m.chainMax + ') x ' + m.chainStep + ') )';
    $('src').textContent = 'Source: ' + DATA.source + ' · Snapshot date ' + DATA.as_of
      + ' · Floor $' + Math.round(DATA.floor_usd / 1e6) + 'M · Model ' + DATA.model_version + '.';
  }

  function fillSelects() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    cats.forEach(function (c) { $('category').appendChild(new Option(c, c)); });
    chains.forEach(function (c) { $('chain').appendChild(new Option(c, c)); });
    $('category').value = state.category; $('chain').value = state.chain;
    $('status').value = state.status; $('sort').value = state.sort; $('q').value = state.q;
  }

  function renderTable() {
    var list = sorted(visibleRows());
    var tbody = $('rows');
    tbody.innerHTML = '';
    $('empty').hidden = list.length > 0;
    $('count').textContent = state.status === 'live'
      ? list.length + ' protocols that already have a token — market cap shown, not a model estimate.'
      : list.length + ' of ' + DATA.board_size + ' pre-token protocols shown'
        + (state.status === 'watch' ? ' (watchlist only)' : '') + '. Click a row for its farm plan.';
    var max = 1;
    list.forEach(function (r) { if ((r.implied_value_usd || 0) > max) max = r.implied_value_usd; });
    list.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.tabIndex = 0;
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var gc = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var badge = r.live ? '<span class="badge live">already trades</span>'
        : r.watchlist ? '<span class="badge watch">watchlist</span>' : '<span class="badge pre">no token</span>';
      var valCell = r.live ? fmtUsd(r.implied_value_usd)
        : '<div class="bar" aria-hidden="true"><i style="width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%"></i></div><span class="num">' + fmtUsd(r.implied_value_usd) + '</span>';
      tr.innerHTML = '<td class="num">' + (r.live ? '—' : r.rank) + '</td>'
        + '<td><div class="name"><b>' + esc(r.name) + '</b><span>' + esc(r.category || 'Other') + ' on '
        + esc((r.chains || []).slice(0, 2).join(', ') || 'an unnamed chain') + '</span></div></td>'
        + '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>'
        + '<td class="num ' + gc + '">' + growth + '</td>'
        + '<td class="num">' + fmtAge(r.age_days) + '</td>'
        + '<td>' + valCell + '</td><td>' + badge + '</td>';
      tr.addEventListener('click', function () { openDetail(r.slug); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } });
      tbody.appendChild(tr);
    });
  }

  function openDetail(slug) {
    var r = DATA.rows.filter(function (x) { return x.slug === slug; })[0];
    var dlg = $('detail'), body = $('detail-body');
    if (!r) {
      var live = DATA.live.filter(function (x) { return x.slug === slug; })[0];
      if (!live) return;
      state.selected = slug; writeHash();
      body.innerHTML = '<div class="detail-body"><div class="detail-head"><div><span class="badge live">already trades</span><h2 id="detail-title">'
        + esc(live.name) + '</h2><p class="sub">' + esc(live.category || 'Other') + ' on '
        + esc((live.chains || []).join(', ')) + '</p></div><button type="button" class="close">Close</button></div>'
        + '<div class="kv"><div><span>TVL</span><b>' + fmtUsd(live.tvl_usd) + '</b></div><div><span>Market cap</span><b>'
        + fmtUsd(live.mcap_usd) + '</b></div></div>'
        + '<p class="note">This protocol already has a token that trades, so there is no implied value to model and no pre-token farm plan. It is listed here only so the reader can tell it apart from the ranked board.</p></div>';
      body.querySelector('.close').addEventListener('click', function () { dlg.close(); });
      if (!dlg.open) dlg.showModal();
      return;
    }
    state.selected = slug; writeHash();
    var recomputed = impliedOf(r);
    var steps = (r.farm_steps || []).map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return '<li><b>' + esc(action) + '</b><span>' + esc(tail) + '</span></li>';
    }).join('');
    body.innerHTML = '<div class="detail-body"><div class="detail-head"><div><span class="badge '
      + (r.watchlist ? 'watch">watchlist' : 'pre">no token') + '</span><h2 id="detail-title">' + esc(r.name)
      + '</h2><p class="sub">Rank ' + r.rank + ' of ' + DATA.board_size + ' · ' + esc(r.category || 'Other')
      + ' on ' + esc((r.chains || []).join(', ') || 'an unnamed chain') + '</p></div>'
      + '<button type="button" class="close">Close</button></div>'
      + '<div class="kv"><div><span>TVL</span><b>' + fmtUsd(r.tvl_usd) + '</b></div>'
      + '<div><span>7-day growth</span><b>' + fmtPct(r.change_7d) + '</b></div>'
      + '<div><span>Age with no token</span><b>' + fmtAge(r.age_days) + '</b></div>'
      + '<div><span>Category multiple</span><b>' + r.model.base_multiple + '</b></div>'
      + '<div><span>Growth multiplier</span><b>' + r.model.growth_multiplier + '</b></div>'
      + '<div><span>Maturity multiplier</span><b>' + r.model.maturity_multiplier + '</b></div>'
      + '<div><span>Chain multiplier</span><b>' + r.model.chain_multiplier + '</b></div>'
      + '<div><span>Implied value</span><b>' + fmtUsd(r.implied_value_usd) + '</b></div></div>'
      + '<p class="sub">The page recomputes this row as ' + fmtUsd(recomputed)
      + (recomputed === r.implied_value_usd ? ' — the same number board.json carries.' : ' — which differs from the board; the data would be stale.')
      + ' Implied value is an estimate, not a price.</p>'
      + '<h3>Farm plan — 7 steps</h3><ol class="steps">' + steps + '</ol>'
      + '<p class="note">Never pay anyone to claim an airdrop for you, and never connect a wallet to a link that did not come from the protocol itself. A token may never launch; farm only money you can afford to lock up.</p></div>';
    body.querySelector('.close').addEventListener('click', function () { dlg.close(); });
    if (!dlg.open) dlg.showModal();
  }

  function render() { renderTable(); }

  readHash();
  renderStats();
  fillSelects();
  render();
  $('q').addEventListener('input', function () { state.q = $('q').value; writeHash(); render(); });
  $('category').addEventListener('change', function () { state.category = $('category').value; writeHash(); render(); });
  $('chain').addEventListener('change', function () { state.chain = $('chain').value; writeHash(); render(); });
  $('status').addEventListener('change', function () { state.status = $('status').value; writeHash(); render(); });
  $('sort').addEventListener('change', function () { state.sort = $('sort').value; render(); });
  $('clear').addEventListener('click', function () {
    state.q = ''; state.category = 'all'; state.chain = 'all'; state.status = 'pre'; state.sort = 'implied';
    $('q').value = ''; $('category').value = 'all'; $('chain').value = 'all'; $('status').value = 'pre'; $('sort').value = 'implied';
    writeHash(); render();
  });
  $('detail').addEventListener('close', function () { state.selected = null; writeHash(); });
  if (state.selected) openDetail(state.selected);
})();
