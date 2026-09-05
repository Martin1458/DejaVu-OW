// History Browser (see DEJAVU_OW_PLAN.md §6.2) — standalone window, no GEP
// dependency. Reads/writes the same IndexedDB database as the background
// window via storage.js (shared origin, so a second connection is fine).

(function () {
  var allPlayers = [];
  var allRecords = {}; // battlenet_tag -> win/loss summary from getAllRecords(), or absent
  var sortKey = 'last_seen';
  var sortDir = -1; // most recent first by default

  var rowsEl, statusEl, searchEl, headerCells;
  var modalBackdrop, modalName, modalTag, modalRecord, modalNotes, modalTags, modalNames, modalStatus;
  var activeTag = null;

  // Separate log file from the background window's (each window is its own JS
  // context, so this is a distinct DejaVuFileLog instance/file, not shared) —
  // but until now this window logged nowhere at all, which was a real blind
  // spot when it froze with nothing to inspect afterward.
  function logDiag(line) {
    console.log('[DejaVuHistory] ' + line);
    if (window.DejaVuFileLog) DejaVuFileLog.log('[history] ' + line);
  }

  function init() {
    DejaVuFileLog.init();
    logDiag('history window init start');

    rowsEl = document.getElementById('rows');
    statusEl = document.getElementById('status');
    searchEl = document.getElementById('search');
    headerCells = document.querySelectorAll('thead th');

    modalBackdrop = document.getElementById('modal-backdrop');
    modalName = document.getElementById('modal-name');
    modalTag = document.getElementById('modal-tag');
    modalRecord = document.getElementById('modal-record');
    modalNotes = document.getElementById('modal-notes');
    modalTags = document.getElementById('modal-tags');
    modalNames = document.getElementById('modal-names');
    modalStatus = document.getElementById('modal-status');

    headerCells.forEach(function (th) {
      var key = th.getAttribute('data-key');
      if (!key) return; // derived columns (W/L splits) aren't backed by a plain sortable field
      th.addEventListener('click', function () {
        if (sortKey === key) {
          sortDir = -sortDir;
        } else {
          sortKey = key;
          sortDir = 1;
        }
        render();
      });
    });

    searchEl.addEventListener('input', render);
    document.getElementById('export-btn').addEventListener('click', exportJson);
    document.getElementById('clear-btn').addEventListener('click', clearHistory);
    document.getElementById('seed-btn').addEventListener('click', seedRandomData);
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-save').addEventListener('click', saveModal);
    document.getElementById('modal-delete').addEventListener('click', deleteFromModal);
    modalBackdrop.addEventListener('click', function (e) {
      if (e.target === modalBackdrop) closeModal();
    });

    initTierPicker();
    logDiag('init complete, current tier = ' + DejaVuSettings.getDetailLevel());
    load();
  }

  var TIER_HINTS = {
    basic: 'Tracks who you’ve played with/against, and when. Smallest footprint.',
    standard: 'Adds one row per match (map/result when available) plus who was there. Grows with matches played.',
    full: 'Adds personal kill/death tracking against each player, from the kill feed. Same row growth as Standard, slightly wider rows.'
  };

  function initTierPicker() {
    var radios = document.querySelectorAll('input[name="tier"]');
    var hintEl = document.getElementById('tier-hint');
    var current = DejaVuSettings.getDetailLevel();

    radios.forEach(function (radio) {
      radio.checked = (radio.value === current);
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        DejaVuSettings.setDetailLevel(radio.value);
        hintEl.textContent = TIER_HINTS[radio.value] || '';
      });
    });

    hintEl.textContent = TIER_HINTS[current] || '';
  }

  function load() {
    statusEl.textContent = 'loading...';
    logDiag('load: getAllPlayers + getAllRecords start');
    Promise.all([
      DejaVuStorage.getAllPlayers(),
      DejaVuStorage.getAllRecords()
    ]).then(function (results) {
      allPlayers = results[0];
      allRecords = results[1];
      logDiag('load: resolved with ' + allPlayers.length + ' player(s), ' + Object.keys(allRecords).length + ' record(s)');
      render();
      renderLeaderboards();
      logDiag('load: render + renderLeaderboards complete');
    }).catch(function (err) {
      logDiag('load: failed — ' + err);
      statusEl.textContent = 'failed to load: ' + err;
    });
  }

  function renderLeaderboards() {
    renderLeaderboard('lb-teammate', 'as_teammate_count');
    renderLeaderboard('lb-enemy', 'as_enemy_count');
    renderLeaderboard('lb-kills', 'kills_on_them');
    renderLeaderboard('lb-deaths', 'deaths_to_them');
  }

  function renderLeaderboard(elId, countKey) {
    var el = document.getElementById(elId);
    var top = allPlayers.filter(function (p) { return p[countKey] > 0; })
      .sort(function (a, b) { return b[countKey] - a[countKey]; })
      .slice(0, 5);

    el.innerHTML = '';
    if (!top.length) {
      var empty = document.createElement('li');
      empty.className = 'leaderboard-empty';
      empty.textContent = 'nobody yet';
      el.appendChild(empty);
      return;
    }

    top.forEach(function (p) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.textContent = p.display_name;
      var count = document.createElement('span');
      count.className = 'lb-count';
      count.textContent = p[countKey] + 'x';
      li.appendChild(name);
      li.appendChild(count);
      el.appendChild(li);
    });
  }

  function formatDate(timestamp) {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString();
  }

  // record is one entry from getAllRecords() (or undefined if no completed
  // matches together yet). Draws are only appended when there've been any,
  // so the common case reads as a plain "3-1" rather than always "3-1-0".
  function formatWL(record, winKey, lossKey, drawKey) {
    if (!record) return '-';
    var wins = record[winKey] || 0;
    var losses = record[lossKey] || 0;
    var draws = record[drawKey] || 0;
    if (!wins && !losses && !draws) return '-';
    return wins + '-' + losses + (draws ? '-' + draws : '');
  }

  function render() {
    logDiag('render start, ' + allPlayers.length + ' player(s) in memory, sortKey=' + sortKey);
    var query = searchEl.value.trim().toLowerCase();
    var filtered = allPlayers.filter(function (p) {
      if (!query) return true;
      return (p.display_name || '').toLowerCase().indexOf(query) !== -1 ||
        (p.battlenet_tag || '').toLowerCase().indexOf(query) !== -1;
    });

    filtered.sort(function (a, b) {
      var av = a[sortKey], bv = b[sortKey];
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });

    headerCells.forEach(function (th) {
      var key = th.getAttribute('data-key');
      th.classList.toggle('sorted', key === sortKey);
      th.setAttribute('data-arrow', sortDir === 1 ? '▲' : '▼');
    });

    rowsEl.innerHTML = '';
    filtered.forEach(function (p) {
      var record = allRecords[p.battlenet_tag];
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(p.display_name) + '</td>' +
        '<td class="tag">' + escapeHtml(p.battlenet_tag) + '</td>' +
        '<td>' + p.encounter_count + '</td>' +
        '<td>' + p.as_teammate_count + '</td>' +
        '<td>' + p.as_enemy_count + '</td>' +
        '<td>' + formatWL(record, 'wins', 'losses', 'draws') + '</td>' +
        '<td>' + formatWL(record, 'teammate_wins', 'teammate_losses', 'teammate_draws') + '</td>' +
        '<td>' + formatWL(record, 'enemy_wins', 'enemy_losses', 'enemy_draws') + '</td>' +
        '<td>' + (p.kills_on_them || 0) + '</td>' +
        '<td>' + (p.deaths_to_them || 0) + '</td>' +
        '<td>' + formatDate(p.first_seen) + '</td>' +
        '<td>' + formatDate(p.last_seen) + '</td>';
      tr.addEventListener('click', function () { openModal(p.battlenet_tag); });
      rowsEl.appendChild(tr);
    });

    if (!allPlayers.length) {
      statusEl.textContent = 'no players recorded yet — play a match to start building history';
      statusEl.style.display = '';
    } else if (!filtered.length) {
      statusEl.textContent = 'no matches for "' + query + '"';
      statusEl.style.display = '';
    } else {
      statusEl.style.display = 'none';
    }

    logDiag('render done, ' + filtered.length + ' row(s) drawn');
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function timestampForFilename(date) {
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
      '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  }

  function exportJson() {
    var statusEl = document.getElementById('export-status');
    var now = new Date();
    var filePath = overwolf.io.paths.documents + '\\DejaVu-OW\\exports\\players-' + timestampForFilename(now) + '.json';

    overwolf.io.writeFileContents(
      filePath,
      JSON.stringify(allPlayers, null, 2),
      overwolf.io.enums.eEncoding.UTF8,
      false,
      function (result) {
        statusEl.textContent = result.success ? ('saved to ' + filePath) : ('failed: ' + result.error);
      }
    );
  }

  function clearHistory() {
    var statusEl = document.getElementById('clear-status');
    if (!confirm('Delete all ' + allPlayers.length + ' recorded player(s)? This cannot be undone.')) return;

    DejaVuStorage.clearAllPlayers().then(function () {
      statusEl.textContent = 'cleared';
      load();
    }).catch(function (err) {
      statusEl.textContent = 'failed: ' + err;
    });
  }

  function seedRandomData() {
    var statusEl = document.getElementById('seed-status');
    DejaVuStorage.seedRandomPlayers(20).then(function (count) {
      statusEl.textContent = 'added ' + count + ' fake player(s)';
      load();
    }).catch(function (err) {
      statusEl.textContent = 'failed: ' + err;
    });
  }

  function openModal(tag) {
    logDiag('openModal: ' + tag);
    var player = allPlayers.filter(function (p) { return p.battlenet_tag === tag; })[0];
    if (!player) {
      logDiag('openModal: no matching player in memory for ' + tag);
      return;
    }

    activeTag = tag;
    modalStatus.textContent = '';
    modalName.textContent = player.display_name;
    modalTag.textContent = player.battlenet_tag;
    modalNotes.value = player.notes || '';
    modalTags.value = (player.tags || []).join(', ');

    renderNameHistory(player);
    modalRecord.textContent = 'loading...';
    modalBackdrop.classList.remove('hidden');

    DejaVuStorage.getRecordAgainst(tag).then(function (summary) {
      logDiag('openModal: getRecordAgainst resolved for ' + tag);
      renderRecord(summary, player);
    }).catch(function (err) {
      logDiag('openModal: getRecordAgainst failed for ' + tag + ': ' + err);
      modalRecord.textContent = 'failed to load: ' + err;
    });
  }

  function closeModal() {
    logDiag('closeModal');
    modalBackdrop.classList.add('hidden');
    activeTag = null;
  }

  function renderNameHistory(player) {
    modalNames.innerHTML = '';
    var history = player.name_history || [];
    if (!history.length) {
      modalNames.innerHTML = '<div class="leaderboard-empty">no history recorded</div>';
      return;
    }
    // most recent first
    history.slice().reverse().forEach(function (entry) {
      var div = document.createElement('div');
      div.textContent = entry.name + ' — ' + formatDate(entry.timestamp);
      modalNames.appendChild(div);
    });
  }

  function renderRecord(summary, player) {
    var lines = [];

    if (summary) {
      lines.push('Overall: ' + summary.wins + 'W–' + summary.losses + 'L' +
        (summary.draws ? '–' + summary.draws + 'D' : ''));
      lines.push('As teammates: ' + summary.teammate_wins + 'W–' + summary.teammate_losses + 'L' +
        (summary.teammate_draws ? '–' + summary.teammate_draws + 'D' : ''));
      lines.push('As enemies: ' + summary.enemy_wins + 'W–' + summary.enemy_losses + 'L' +
        (summary.enemy_draws ? '–' + summary.enemy_draws + 'D' : ''));
    } else {
      lines.push('No completed matches on record together (needs Standard detail level or higher).');
    }

    var kills = player.kills_on_them || 0;
    var deaths = player.deaths_to_them || 0;
    if (kills || deaths) {
      lines.push('Kills on them: ' + kills + '  ·  Deaths to them: ' + deaths);
    }

    var streakLine = '';
    if (summary && summary.streak_type === 'victory') {
      streakLine = '<span class="streak-win">Current streak: ' + summary.streak_count + ' win' + (summary.streak_count > 1 ? 's' : '') + '</span>';
    } else if (summary && summary.streak_type === 'defeat') {
      streakLine = '<span class="streak-loss">Current streak: ' + summary.streak_count + ' loss' + (summary.streak_count > 1 ? 'es' : '') + '</span>';
    }

    modalRecord.innerHTML = lines.map(escapeHtml).join('<br>') + (streakLine ? '<br>' + streakLine : '');
  }

  function saveModal() {
    if (!activeTag) return;
    var tags = modalTags.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);

    DejaVuStorage.updatePlayerFields(activeTag, {
      notes: modalNotes.value,
      tags: tags
    }).then(function () {
      modalStatus.textContent = 'saved';
      return DejaVuStorage.getAllPlayers();
    }).then(function (players) {
      allPlayers = players;
      render();
    }).catch(function (err) {
      modalStatus.textContent = 'failed: ' + err;
    });
  }

  function deleteFromModal() {
    if (!activeTag) return;
    var player = allPlayers.filter(function (p) { return p.battlenet_tag === activeTag; })[0];
    var label = player ? player.display_name : activeTag;
    if (!confirm('Delete all history for ' + label + '? This cannot be undone.')) return;

    DejaVuStorage.deletePlayer(activeTag).then(function () {
      closeModal();
      load();
    }).catch(function (err) {
      modalStatus.textContent = 'failed: ' + err;
    });
  }

  init();
})();
