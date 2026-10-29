// History Browser (see DEJAVU_OW_PLAN.md §6.2) — standalone window, no GEP
// dependency. Reads/writes the same IndexedDB database as the background
// window via storage.js (shared origin, so a second connection is fine).

(function () {
  var allPlayers = [];
  var allRecords = {}; // battlenet_tag -> win/loss summary from getAllRecords(), or absent
  var sortKey = 'last_seen';
  var sortDir = -1; // most recent first by default

  var rowsEl, statusEl, searchEl, headerCells;
  var modalBackdrop, modalName, modalTag, modalRecord, modalMatches, modalNotes, modalTags, modalNames, modalStatus;
  var activeTag = null;

  // Separate log file from the background window's (each window is its own JS
  // context, so this is a distinct DejaVuFileLog instance/file, not shared) —
  // but until now this window logged nowhere at all, which was a real blind
  // spot when it froze with nothing to inspect afterward.
  function logDiag(line) {
    console.log('[DejaVuHistory] ' + line);
    if (window.DejaVuFileLog) DejaVuFileLog.log('[history] ' + line);
  }

  // Overwolf's product guidelines want the hotkeys discoverable from inside
  // the app, and Overwolf's own settings are the only place they can be
  // changed — so print what is actually bound, not the manifest defaults, and
  // follow along if the user rebinds one while this window is open.
  function renderHotkeys() {
    var el = document.getElementById('hotkey-list');
    var rows = [
      { name: 'toggle_overlay', text: 'show or hide the overlay during a match' },
      { name: 'open_history', text: 'open or close this window' }
    ];
    DejaVuHotkeys.watch(function (keys) {
      logDiag('hotkeys shown in settings: ' + JSON.stringify(keys));
      el.textContent = '';
      rows.forEach(function (row) {
        var line = document.createElement('div');
        var key = document.createElement('b');
        // Built as nodes rather than innerHTML: the binding string comes from
        // outside this window.
        key.textContent = DejaVuHotkeys.label(keys, row.name) || 'Not set';
        line.appendChild(key);
        line.appendChild(document.createTextNode(' — ' + row.text));
        el.appendChild(line);
      });
    });
  }

  function init() {
    DejaVuFileLog.init('history');
    logDiag('history window init start');

    rowsEl = document.getElementById('rows');
    statusEl = document.getElementById('status');
    searchEl = document.getElementById('search');
    headerCells = document.querySelectorAll('thead th');

    modalBackdrop = document.getElementById('modal-backdrop');
    modalName = document.getElementById('modal-name');
    modalTag = document.getElementById('modal-tag');
    modalRecord = document.getElementById('modal-record');
    modalMatches = document.getElementById('modal-matches');
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
    document.getElementById('import-btn').addEventListener('click', function () {
      document.getElementById('import-file').click();
    });
    document.getElementById('import-file').addEventListener('change', importJson);
    document.getElementById('clear-btn').addEventListener('click', clearHistory);
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-save').addEventListener('click', saveModal);
    document.getElementById('modal-delete').addEventListener('click', deleteFromModal);
    modalBackdrop.addEventListener('click', function (e) {
      if (e.target === modalBackdrop) closeModal();
    });

    var settingsBackdrop = document.getElementById('settings-backdrop');
    document.getElementById('settings-gear-btn').addEventListener('click', function () {
      settingsBackdrop.classList.remove('hidden');
    });
    document.getElementById('settings-close').addEventListener('click', function () {
      settingsBackdrop.classList.add('hidden');
    });
    settingsBackdrop.addEventListener('click', function (e) {
      if (e.target === settingsBackdrop) settingsBackdrop.classList.add('hidden');
    });
    document.querySelectorAll('.preset-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyPreset(btn.getAttribute('data-preset'));
      });
    });

    var movableEl = document.getElementById('overlay-movable');
    movableEl.checked = DejaVuSettings.isOverlayMovable();
    movableEl.addEventListener('change', function () {
      var movable = movableEl.checked;
      DejaVuSettings.setOverlayMovable(movable);
      DejaVuWindows.applyOverlayMovable(movable);
      logDiag('overlay movable -> ' + movable);
    });

    document.getElementById('reset-overlay-position').addEventListener('click', function () {
      // A window dragged off a monitor that is no longer attached would
      // otherwise be unreachable, since the overlay only exists in game.
      DejaVuSettings.clearOverlayPositions();
      document.getElementById('reset-position-status').textContent =
        'Back to the default corners at the next match.';
      logDiag('overlay positions reset');
    });

    initTierPicker();
    initOverlayTogglePicker();
    renderHotkeys();
    initBackups();
    initRefreshOnFocus();
    logDiag('init complete, current tier = ' + DejaVuSettings.getDetailLevel());
    load();
  }

  // The background window keeps writing while this one is open, so a window
  // left open across a match used to show stale data until it was reopened.
  // Reloads whenever it regains focus — but not while a player is open, where
  // a reload could replace the record under unsaved notes. Debounced because
  // a single click into the window can deliver more than one focus event.
  var REFRESH_DEBOUNCE_MS = 1500;
  var lastFocusRefresh = 0;

  function initRefreshOnFocus() {
    window.addEventListener('focus', function () {
      if (activeTag) return;
      var now = Date.now();
      if (now - lastFocusRefresh < REFRESH_DEBOUNCE_MS) return;
      lastFocusRefresh = now;
      logDiag('window focused — reloading');
      load();
    });
  }

  var TIER_HINTS = {
    basic: 'Remembers who you met and when. Uses the least space.',
    standard: 'Also remembers who won each match, so win/loss records work.',
    full: 'Also remembers your kills and deaths against each player.'
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
        refreshOverlayToggleAvailability();
      });
    });

    hintEl.textContent = TIER_HINTS[current] || '';
  }

  // Presets (2026-09-06 ask): a one-click bundle of tier + overlay toggles for
  // people who don't want to think about the individual pieces below. Still
  // just calls the same setters the individual controls use, so everything
  // stays in sync — no separate "preset mode" state to fall out of sync with.
  var PRESETS = {
    basic: {
      tier: 'basic',
      toggles: { showRecency: true, showNotes: true, showRecord: false, showLastHero: false, showMostPlayedHero: false, showLifetimeKD: false, showMatchKD: false }
    },
    standard: {
      tier: 'standard',
      toggles: { showRecency: true, showNotes: true, showRecord: true, showLastHero: true, showMostPlayedHero: true, showLifetimeKD: false, showMatchKD: false }
    },
    full: {
      tier: 'full',
      toggles: { showRecency: true, showNotes: true, showRecord: true, showLastHero: true, showMostPlayedHero: true, showLifetimeKD: true, showMatchKD: true }
    }
  };

  function applyPreset(name) {
    var preset = PRESETS[name];
    if (!preset) return;
    logDiag('applyPreset: ' + name);

    DejaVuSettings.setDetailLevel(preset.tier);
    Object.keys(preset.toggles).forEach(function (key) {
      DejaVuSettings.setOverlayToggle(key, preset.toggles[key]);
    });

    // Re-sync the visible controls to match — same elements initTierPicker/
    // initOverlayTogglePicker already wired, just re-reading the values we
    // just set rather than re-attaching listeners.
    document.querySelectorAll('input[name="tier"]').forEach(function (radio) {
      radio.checked = (radio.value === preset.tier);
    });
    document.getElementById('tier-hint').textContent = TIER_HINTS[preset.tier] || '';
    document.querySelectorAll('input[data-toggle]').forEach(function (cb) {
      var key = cb.getAttribute('data-toggle');
      cb.checked = DejaVuSettings.getOverlayToggle(key);
    });
    refreshOverlayToggleAvailability();
  }

  // Independent of the tier picker above: what's tracked (tier) vs. what the
  // overlay actually shows out of it (these checkboxes) are separate
  // decisions. A toggle whose data isn't tracked at the current tier is
  // disabled rather than hidden — so its saved preference survives raising
  // the tier later without needing to be re-checked.
  function initOverlayTogglePicker() {
    var checkboxes = document.querySelectorAll('input[data-toggle]');
    checkboxes.forEach(function (cb) {
      var key = cb.getAttribute('data-toggle');
      cb.checked = DejaVuSettings.getOverlayToggle(key);
      cb.addEventListener('change', function () {
        DejaVuSettings.setOverlayToggle(key, cb.checked);
      });
    });
    refreshOverlayToggleAvailability();
  }

  function refreshOverlayToggleAvailability() {
    var tier = DejaVuSettings.getDetailLevel();
    document.querySelectorAll('[data-toggle-row]').forEach(function (rowEl) {
      var requires = rowEl.getAttribute('data-requires'); // absent, 'standard', or 'full'
      var available = !requires ? true : (requires === 'full' ? tier === 'full' : tier !== 'basic');
      rowEl.classList.toggle('disabled', !available);
      var cb = rowEl.querySelector('input[data-toggle]');
      if (cb) cb.disabled = !available;
    });
  }

  function load() {
    statusEl.textContent = 'Loading...';
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
      refreshRestoreOffer();
      logDiag('load: render + renderLeaderboards complete');
    }).catch(function (err) {
      logDiag('load: failed — ' + err);
      statusEl.textContent = 'Could not load your history: ' + err;
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
      empty.textContent = 'Nobody yet';
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
    if (!wins && !losses) return '-';
    return wins + '-' + losses;
  }

  function render() {
    logDiag('render start, ' + allPlayers.length + ' player(s) in memory, sortKey=' + sortKey);
    var query = searchEl.value.trim().toLowerCase();
    // Notes and tags are searched too, so "toxic" or "duo" finds everyone
    // you've labelled that way.
    var filtered = allPlayers.filter(function (p) {
      if (!query) return true;
      return [p.display_name, p.battlenet_tag, p.notes, (p.tags || []).join(' ')].some(function (field) {
        return typeof field === 'string' && field.toLowerCase().indexOf(query) !== -1;
      });
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
        '<td>' + numCell(p.encounter_count) + '</td>' +
        '<td>' + numCell(p.as_teammate_count) + '</td>' +
        '<td>' + numCell(p.as_enemy_count) + '</td>' +
        '<td>' + formatWL(record, 'wins', 'losses', 'draws') + '</td>' +
        '<td>' + formatWL(record, 'teammate_wins', 'teammate_losses', 'teammate_draws') + '</td>' +
        '<td>' + formatWL(record, 'enemy_wins', 'enemy_losses', 'enemy_draws') + '</td>' +
        '<td>' + numCell(p.kills_on_them) + '</td>' +
        '<td>' + numCell(p.deaths_to_them) + '</td>' +
        '<td>' + formatDate(p.first_seen) + '</td>' +
        '<td>' + formatDate(p.last_seen) + '</td>';
      tr.addEventListener('click', function () { openModal(p.battlenet_tag); });
      rowsEl.appendChild(tr);
    });

    if (!allPlayers.length) {
      statusEl.textContent = 'No players yet. Play a match to start building history.';
      statusEl.style.display = '';
    } else if (!filtered.length) {
      statusEl.textContent = 'Nobody matches "' + query + '"';
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

  // The count columns below go into innerHTML unescaped because they're
  // supposed to be numbers this app wrote itself. importPlayers now guarantees
  // that for anything arriving from a file, but records imported before that
  // validation existed are already in the store, so coerce here too rather
  // than trusting the type — a non-numeric value renders as 0 instead of
  // reaching the DOM as markup.
  function numCell(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
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

    // A full backup since 0.4.0 (same format as the automatic ones, see
    // backup.js): the per-match rows travel with the players, so a restore
    // keeps W/L records and streaks.
    DejaVuBackup.build().then(function (backup) {
      logDiag('exportJson: ' + backup.players.length + ' player(s), ' + backup.encounters.length + ' match(es)');
      overwolf.io.writeFileContents(
        filePath,
        JSON.stringify(backup, null, 2),
        overwolf.io.enums.eEncoding.UTF8,
        false,
        function (result) {
          statusEl.textContent = result.success ? ('Saved to ' + filePath) : ('Could not save: ' + result.error);
        }
      );
    }).catch(function (err) {
      logDiag('exportJson: failed to read the database: ' + err);
      statusEl.textContent = 'Could not export: ' + err;
    });
  }

  // Plan §11 G3. Reads the picked file with the DOM File API (not overwolf.io —
  // <input type="file"> already gives us the file's contents directly, and
  // this window's Chromium context supports it same as any web page) rather
  // than asking the user to type a path. See DejaVuStorage.importPlayers for
  // the actual merge rule.
  function importJson(event) {
    var statusEl = document.getElementById('import-status');
    var file = event.target.files && event.target.files[0];
    event.target.value = ''; // allow re-selecting the same file next time
    if (!file) return;

    statusEl.textContent = 'Reading ' + file.name + '...';

    var reader = new FileReader();
    reader.onerror = function () {
      logDiag('importJson: failed to read ' + file.name);
      statusEl.textContent = 'Could not read that file.';
    };
    reader.onload = function () {
      var records;
      try {
        records = JSON.parse(reader.result);
      } catch (e) {
        logDiag('importJson: invalid JSON in ' + file.name + ': ' + e);
        statusEl.textContent = 'That file is not valid JSON.';
        return;
      }
      // Two shapes: a bare players array (every export before 0.4.0), or a
      // full backup object carrying the per-match rows too.
      var parsed = DejaVuBackup.parse(records);
      if (!parsed) {
        logDiag('importJson: ' + file.name + ' is neither a players array nor a backup');
        statusEl.textContent = 'That does not look like a DejaVu export.';
        return;
      }

      DejaVuBackup.restore(parsed).then(function (summary) {
        logDiag('importJson: ' + JSON.stringify(summary));
        statusEl.textContent = restoreMessage(summary);
        // Whatever was protected for a restore offer is superseded by this.
        DejaVuBackup.releaseProtection();
        load();
      }).catch(function (err) {
        logDiag('importJson: importPlayers failed: ' + err);
        statusEl.textContent = 'Could not import: ' + err;
      });
    };
    reader.readAsText(file);
  }

  // skipped covers records the store refused as unreadable (no usable battle
  // tag). It used to be counted and then dropped from the message, which
  // meant a half-unreadable file looked like a clean import — worth saying
  // out loud now that validation rejects more.
  function restoreMessage(summary) {
    var message = 'Added ' + summary.added + ' and updated ' + summary.replaced + '. Kept ' + summary.kept + ' you already had.';
    if (summary.matches) {
      message += ' Restored ' + summary.matches + ' match' + (summary.matches === 1 ? '' : 'es') + '.';
    }
    if (summary.skipped) message += ' Ignored ' + summary.skipped + ' unreadable entries.';
    return message;
  }

  // Backups section in Settings, plus the restore offer shown over an empty
  // history (see backup.js for when the background writes them).
  function initBackups() {
    var statusEl = document.getElementById('backup-status');
    document.getElementById('backup-open').addEventListener('click', DejaVuBackup.openFolder);
    document.getElementById('backup-now').addEventListener('click', function () {
      statusEl.textContent = 'Backing up...';
      DejaVuBackup.writeNow('manual', function (result) {
        statusEl.textContent = result ? backupLine(result) : 'Nothing to back up yet.';
      });
    });
    DejaVuBackup.findLatest(function (latest) {
      statusEl.textContent = latest ? backupLine(latest) :
        'No backup yet. One is saved after every match.';
    });

    document.getElementById('restore-yes').addEventListener('click', restoreFromOffer);
    document.getElementById('restore-no').addEventListener('click', function () {
      DejaVuBackup.releaseProtection();
      document.getElementById('restore-offer').classList.add('hidden');
      logDiag('restore offer dismissed, starting fresh');
    });
  }

  function backupLine(backup) {
    return 'Last backup: ' + formatDate(Date.parse(backup.at)) + ', ' + backup.players + ' players.';
  }

  var restoreOffer = null;

  // Only ever offered over an empty history — DejaVuBackup.findRestoreOffer
  // checks that itself, so this is safe to call on every load.
  function refreshRestoreOffer() {
    DejaVuBackup.findRestoreOffer(function (backup) {
      restoreOffer = backup;
      var el = document.getElementById('restore-offer');
      if (!backup) { el.classList.add('hidden'); return; }
      document.getElementById('restore-text').textContent =
        'Your history is empty, but there is a backup from ' + formatDate(Date.parse(backup.at)) +
        ' with ' + backup.players + ' players and ' + backup.matches + ' matches.';
      el.classList.remove('hidden');
    });
  }

  function restoreFromOffer() {
    if (!restoreOffer) return;
    var textEl = document.getElementById('restore-text');
    textEl.textContent = 'Restoring...';
    DejaVuBackup.restore(restoreOffer.data).then(function (summary) {
      logDiag('restore from ' + restoreOffer.path + ': ' + JSON.stringify(summary));
      DejaVuBackup.releaseProtection();
      document.getElementById('restore-offer').classList.add('hidden');
      document.getElementById('import-status').textContent = restoreMessage(summary);
      load();
    }).catch(function (err) {
      logDiag('restore failed: ' + err);
      textEl.textContent = 'Could not restore: ' + err;
    });
  }

  function clearHistory() {
    var statusEl = document.getElementById('clear-status');
    if (!confirm('Delete all ' + allPlayers.length + ' players? This cannot be undone.')) return;

    DejaVuStorage.clearAllPlayers().then(function () {
      statusEl.textContent = 'History cleared.';
      load();
    }).catch(function (err) {
      statusEl.textContent = 'Could not clear history: ' + err;
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
    modalRecord.textContent = 'Loading...';
    modalBackdrop.classList.remove('hidden');

    DejaVuStorage.getRecordAgainst(tag).then(function (summary) {
      logDiag('openModal: getRecordAgainst resolved for ' + tag);
      renderRecord(summary, player);
    }).catch(function (err) {
      logDiag('openModal: getRecordAgainst failed for ' + tag + ': ' + err);
      modalRecord.textContent = 'Could not load: ' + err;
    });

    modalMatches.textContent = 'Loading...';
    DejaVuStorage.getMatchesWithPlayer(tag, RECENT_MATCHES_SHOWN).then(function (matches) {
      if (activeTag !== tag) return; // another player was opened meanwhile
      renderMatches(matches);
    }).catch(function (err) {
      logDiag('openModal: getMatchesWithPlayer failed for ' + tag + ': ' + err);
      modalMatches.textContent = 'Could not load: ' + err;
    });
  }

  var RECENT_MATCHES_SHOWN = 10;

  var RESULT_LABELS = {
    victory: { text: 'W', title: 'Won' },
    defeat: { text: 'L', title: 'Lost' },
    draw: { text: 'D', title: 'Draw' }
  };

  // Plan §11 B1: one line per shared match. These rows have been written since
  // Standard tier existed, but nothing showed them until now. Built as nodes,
  // since hero names come from GEP and an imported backup.
  function renderMatches(matches) {
    modalMatches.textContent = '';
    if (!matches.length) {
      var empty = document.createElement('div');
      empty.className = 'leaderboard-empty';
      empty.textContent = 'No matches on record yet (needs Standard or Full).';
      modalMatches.appendChild(empty);
      return;
    }

    matches.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'match-row';

      var label = RESULT_LABELS[m.result];
      var result = document.createElement('span');
      result.className = 'match-result ' + (label ? m.result : 'unknown');
      result.textContent = label ? label.text : '?';
      result.title = label ? label.title : 'No result recorded';
      row.appendChild(result);

      var heroPath = DejaVuHeroIcons.resolve(m.hero_name);
      var hero;
      if (heroPath) {
        hero = document.createElement('img');
        hero.src = heroPath;
        hero.alt = m.hero_name;
        hero.title = m.hero_name;
      } else {
        hero = document.createElement('span');
        hero.className = 'match-hero-empty';
      }
      row.appendChild(hero);

      var date = document.createElement('span');
      date.className = 'match-date';
      date.textContent = formatDate(m.timestamp);
      row.appendChild(date);

      var side = document.createElement('span');
      if (m.was_teammate === true || m.was_teammate === false) {
        side.className = 'match-side ' + (m.was_teammate ? 'with' : 'against');
        side.textContent = m.was_teammate ? 'With you' : 'Against you';
      } else {
        side.className = 'match-side';
      }
      row.appendChild(side);

      if (m.kills || m.deaths) {
        var kd = document.createElement('span');
        kd.className = 'match-kd';
        kd.textContent = 'K/D ' + m.kills + '/' + m.deaths;
        kd.title = 'You killed them ' + m.kills + ', they killed you ' + m.deaths;
        row.appendChild(kd);
      }

      modalMatches.appendChild(row);
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
      modalNames.innerHTML = '<div class="leaderboard-empty">Always seen under this name</div>';
      return;
    }
    // most recent first
    history.slice().reverse().forEach(function (entry) {
      var div = document.createElement('div');
      div.textContent = entry.name + ' (' + formatDate(entry.timestamp) + ')';
      modalNames.appendChild(div);
    });
  }

  function renderRecord(summary, player) {
    var lines = [];

    if (summary) {
      lines.push('Overall: won ' + summary.wins + ', lost ' + summary.losses);
      lines.push('On your team: won ' + summary.teammate_wins + ', lost ' + summary.teammate_losses);
      lines.push('Against you: won ' + summary.enemy_wins + ', lost ' + summary.enemy_losses);
    } else {
      lines.push('No finished matches together yet.');
    }

    var kills = player.kills_on_them || 0;
    var deaths = player.deaths_to_them || 0;
    if (kills || deaths) {
      lines.push('You killed them ' + kills + ', they killed you ' + deaths + '.');
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
      modalStatus.textContent = 'Saved.';
      return DejaVuStorage.getAllPlayers();
    }).then(function (players) {
      allPlayers = players;
      render();
    }).catch(function (err) {
      modalStatus.textContent = 'Could not save: ' + err;
    });
  }

  function deleteFromModal() {
    if (!activeTag) return;
    var player = allPlayers.filter(function (p) { return p.battlenet_tag === activeTag; })[0];
    var label = player ? player.display_name : activeTag;
    if (!confirm('Forget ' + label + ' completely? This cannot be undone.')) return;

    DejaVuStorage.deletePlayer(activeTag).then(function () {
      closeModal();
      load();
    }).catch(function (err) {
      modalStatus.textContent = 'Could not delete: ' + err;
    });
  }

  init();
})();
