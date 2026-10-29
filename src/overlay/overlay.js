// Overlay Renderer (see DEJAVU_OW_PLAN.md §6.1, §7) — dumb display layer.
// All recognition/counting logic lives in the background window; this just
// re-renders the full player table whenever a 'players-update' message
// arrives with the current match's roster (background resends the whole list
// on any change rather than patching individual rows), and updates the
// current match's own result banner on 'match-result'.

(function () {
  var tableEl, headEl, rowsEl, emptyEl, matchResultEl, feedWarningEl;

  // Which optional columns are switched on, per the background's overlay
  // toggles. Defaults to everything on so a stale/older background window that
  // doesn't send `columns` yet still renders a complete table rather than
  // silently dropping columns — this app's windows can each be running their
  // own build until Overwolf is restarted per-window.
  var ALL_COLUMNS = { lastHero: true, matchKD: true, lifetimeKD: true, record: true };
  var columns = ALL_COLUMNS;
  var feedFailed = false;
  // Starts collapsed, and the background expands it at match_start. That way
  // round the window can be shown before any state has been sent without
  // flashing an empty "waiting for players" table over the game.
  var collapsed = true;
  // Mirrors the Settings toggle. The window is made clickthrough when this is
  // off, so mouse events should not arrive at all — this is belt and braces,
  // and it drives the move cursor.
  var movable = false;

  function init() {
    tableEl = document.getElementById('table');
    headEl = document.getElementById('head');
    rowsEl = document.getElementById('rows');
    emptyEl = document.getElementById('empty');
    matchResultEl = document.getElementById('match-result');
    feedWarningEl = document.getElementById('feed-warning');
    document.body.classList.add('collapsed');
    // Read once up front so the cursor is right before the first display-mode
    // message arrives; settings.js shares localStorage across every window.
    setMovable(DejaVuSettings.isOverlayMovable());
    initDragging();
    overwolf.windows.onMessageReceived.addListener(handleMessage);
    applyLiveHotkeys();
  }

  // The panel stays up for the whole match, so the hint has to name the key
  // that actually hides it — read live via DejaVuHotkeys rather than trusting
  // the manifest default, and re-read if the user rebinds it while the panel
  // is on screen.
  function applyLiveHotkeys() {
    DejaVuHotkeys.watch(function (keys) {
      var hintEl = document.getElementById('hide-hint');
      var hide = DejaVuHotkeys.label(keys, 'toggle_overlay');
      if (hide) {
        hintEl.innerHTML = 'Press <kbd id="hide-key"></kbd> to hide';
        document.getElementById('hide-key').textContent = hide;
      } else {
        // Deliberately unbound: there is no key to name, so say what to do.
        hintEl.textContent = 'Set a hide hotkey in Overwolf settings';
      }
      // The same key, named on the badge the user sees while collapsed.
      if (hide) document.getElementById('expand-key').textContent = hide;
      var openHistory = DejaVuHotkeys.label(keys, 'open_history');
      if (openHistory) document.getElementById('history-key').textContent = openHistory;
    });
  }

  function handleMessage(message) {
    if (message.id === 'players-update') {
      columns = message.content.columns || ALL_COLUMNS;
      render(message.content.players || []);
    }
    if (message.id === 'match-result') {
      renderMatchResult(message.content.result);
    }
    // Alt+J: the background flips this rather than hiding the window.
    if (message.id === 'display-mode') {
      setCollapsed(message.content && message.content.collapsed);
      setMovable(message.content && message.content.movable);
    }
    // Sent by the History window the moment the toggle is flipped, so the
    // cursor stops promising a drag that will not happen.
    if (message.id === 'input-mode') {
      setMovable(message.content && message.content.movable);
    }
    // An older background window never sends this, in which case the warning
    // simply stays hidden and the panel behaves exactly as it did before —
    // same degrade-quietly rule the `columns` payload follows, since either
    // window can be running its own build until Overwolf is restarted.
    if (message.id === 'feed-state') {
      renderFeedState(message.content && message.content.failed);
    }
  }

  // Drag-to-move. The window is declared clickthrough:false so it receives
  // the mouse in game — though only where the game leaves a cursor to use
  // (menus, lobby, the scoreboard). During live play Overwatch holds the mouse
  // exclusively and nothing reaches this window, which is also what stops the
  // panel from swallowing clicks in a fight.
  //
  // The new position is read back from the window rather than from dragMove's
  // own result, whose shape differs between Overwolf versions, and is stored
  // per mode: the badge and the table are different shapes in different
  // corners, so one position cannot serve both.
  //
  // The window id is looked up once, up front, so dragMove starts on the press
  // itself. It used to be fetched inside the handler, which put an async
  // round-trip between the button going down and the drag starting — a quick
  // press could be released before dragMove ever ran, which read as the badge
  // "sometimes" refusing to move (2026-09-16).
  function initDragging() {
    var windowId = null;
    overwolf.windows.getCurrentWindow(function (result) {
      if (result && result.success && result.window) windowId = result.window.id;
    });

    document.getElementById('panel').addEventListener('mousedown', function (e) {
      if (e.button !== 0 || !movable || !windowId) return;
      // Otherwise the press also starts a text selection, which competes with
      // the drag.
      e.preventDefault();
      overwolf.windows.dragMove(windowId, function () {
        overwolf.windows.getCurrentWindow(function (after) {
          var bounds = after && after.window && after.window.logicalBounds;
          if (!bounds) return;
          DejaVuSettings.setOverlayPosition(collapsed ? 'collapsed' : 'expanded', bounds.left, bounds.top);
        });
      });
    });
  }

  function setMovable(next) {
    movable = !!next;
    document.body.classList.toggle('movable', movable);
  }

  function setCollapsed(next) {
    collapsed = !!next;
    document.body.classList.toggle('collapsed', collapsed);
  }

  // Shown when the background window reports GEP has stopped responding and
  // has exhausted its own recovery. Deliberately replaces the "waiting for
  // players" line rather than sitting alongside it: waiting is exactly what
  // this is not, and showing both would be the same ambiguity that made the
  // two logged failures invisible in the first place.
  function renderFeedState(failed) {
    feedFailed = !!failed;
    if (feedWarningEl) feedWarningEl.style.display = feedFailed ? 'block' : 'none';
    // The footnote explains columns that aren't on screen in this state, which
    // reads as noise directly under "no game data is coming through".
    var footnoteEl = document.getElementById('footnote');
    if (footnoteEl) footnoteEl.style.display = feedFailed ? 'none' : '';
    renderEmptyState();
  }

  // "Waiting for players" and the feed warning are alternatives, never both.
  // Kept in one place because either a feed-state message or a players-update
  // can be what last changed the answer, and the two arrive in no fixed order.
  function renderEmptyState() {
    if (!emptyEl) return;
    var hasRows = !!(rowsEl && rowsEl.childNodes.length);
    emptyEl.style.display = (hasRows || feedFailed) ? 'none' : '';
  }

  // result: "victory" | "defeat" | "draw" | null (confirmed against real
  // matches — GEP gives these as strings, not a boolean) — used only for the
  // top match-result banner now; the per-player badge below uses `record`.
  function resultBadge(result) {
    if (result === 'victory') return { text: 'W', className: 'victory' };
    if (result === 'defeat') return { text: 'L', className: 'defeat' };
    if (result === 'draw') return { text: 'D', className: 'draw' };
    return null;
  }

  // Formats one win-loss record (green if net-positive, red if net-negative,
  // yellow if level). Drawn matches are excluded entirely rather than shown as
  // a third number — they're rare in Overwatch and a "3-2-1" badge took real
  // effort to read at a glance.
  function recordBadge(record) {
    if (!record) return null;
    var className = record.wins > record.losses ? 'victory' :
      record.losses > record.wins ? 'defeat' : 'draw';
    return { text: record.wins + '-' + record.losses, className: className };
  }

  function buildRecordCell(record, title) {
    var cell = document.createElement('td');
    cell.className = 'result-cell';
    var badge = recordBadge(record);
    if (badge) {
      var pill = document.createElement('span');
      pill.className = 'result-badge ' + badge.className;
      pill.textContent = badge.text;
      pill.title = title + ': won ' + record.wins + ', lost ' + record.losses;
      cell.appendChild(pill);
    }
    return cell;
  }

  // "N matches ago" / "X days ago" (plan §11, 2026-09-06). Coarse buckets are
  // enough here — this is a glance-at-a-panel stat, not a precise clock.
  function formatRelativeTime(timestamp) {
    if (!timestamp) return null;
    var diff = Math.max(0, Date.now() - timestamp);
    var MIN = 60000, HOUR = 3600000, DAY = 86400000, WEEK = DAY * 7, MONTH = DAY * 30;
    if (diff < MIN) return 'just now';
    if (diff < HOUR) return Math.round(diff / MIN) + 'm ago';
    if (diff < DAY) return Math.round(diff / HOUR) + 'h ago';
    if (diff < WEEK) return Math.round(diff / DAY) + 'd ago';
    if (diff < MONTH) return Math.round(diff / WEEK) + 'w ago';
    return Math.round(diff / MONTH) + 'mo ago';
  }

  function recencyText(recency) {
    if (!recency) return null;
    var parts = [];
    if (recency.matchesAgo != null) {
      parts.push(recency.matchesAgo + (recency.matchesAgo === 1 ? ' match ago' : ' matches ago'));
    }
    var relative = formatRelativeTime(recency.lastSeen);
    if (relative) parts.push(relative);
    return parts.length ? parts.join(', ') : null;
  }

  function renderMatchResult(result) {
    var badge = resultBadge(result);
    if (!badge) {
      matchResultEl.style.display = 'none';
      matchResultEl.className = '';
      matchResultEl.textContent = '';
      return;
    }
    // Must be an explicit value, not '': clearing the inline style just falls
    // back to the stylesheet, which hides this element by default — so the
    // match-result banner silently never appeared.
    matchResultEl.style.display = 'block';
    matchResultEl.className = badge.className;
    matchResultEl.textContent = result;
  }

  function render(players) {
    rowsEl.innerHTML = '';
    headEl.innerHTML = '';

    if (!players.length) {
      renderEmptyState();
      tableEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    tableEl.style.display = '';
    headEl.appendChild(buildHeader());
    players.forEach(function (player) {
      rowsEl.appendChild(buildRow(player));
    });
    renderClippedNote();
  }

  // On a screen too short for the whole lobby the panel clips rows rather than
  // running off the monitor (see #table-wrap in overlay.html). Clickthrough
  // means the player cannot scroll to them, so silently dropping people would
  // make the panel quietly lie about who is in the match — say so instead.
  //
  // Measured after layout rather than calculated from row heights, which vary
  // with whether a row wrapped onto two lines.
  function renderClippedNote() {
    var note = document.getElementById('clipped-note');
    var wrap = document.getElementById('table-wrap');
    if (!note || !wrap) return;

    var limit = wrap.clientHeight;
    if (!limit) { note.style.display = 'none'; return; }

    var hidden = 0;
    var rows = rowsEl.children;
    for (var i = 0; i < rows.length; i++) {
      // offsetTop is relative to the nearest positioned ancestor; both the row
      // and the wrapper share the panel's coordinate space here, so comparing
      // the row's bottom against the wrapper's own top+height is what tells us
      // whether it actually landed inside the visible area.
      if (rows[i].offsetTop + rows[i].offsetHeight > wrap.offsetTop + limit) hidden++;
    }

    if (hidden > 0) {
      note.textContent = '+' + hidden + ' more player' + (hidden === 1 ? '' : 's') +
        ' did not fit. Turn off some columns in Settings.';
      note.style.display = '';
    } else {
      note.style.display = 'none';
    }
  }

  // The stats used to be labelled in place ("this match 2K 1D", "You 5 – Them
  // 7"); as bare columns they need a header instead, or "5–7" says nothing on
  // its own. Built here rather than in the HTML because the column set depends
  // on which toggles are on.
  function buildHeader() {
    var cells = [
      { className: 'icon-cell', text: '' },
      { className: 'name-cell', text: 'Player' }
    ];
    if (columns.lastHero) cells.push({ className: 'last-hero-cell', text: 'Last / Most', title: 'Left: hero they played the last time you met. Right: hero they pick most often, with how many times' });
    cells.push({ className: 'count-cell', text: 'DejaVu', title: 'Matches you have played with or against them, counting this one' });
    if (columns.matchKD) cells.push({ className: 'kd-cell', text: 'K/D match', title: 'Kills and deaths between you two in this match' });
    if (columns.lifetimeKD) cells.push({ className: 'kd-cell', text: 'K/D total', title: 'Kills and deaths between you two before this match' });
    if (columns.record) {
      cells.push({ className: 'result-cell', text: 'W/L with', title: 'Wins and losses in matches where they were on your team' });
      cells.push({ className: 'result-cell', text: 'W/L against', title: 'Wins and losses in matches where they were on the enemy team' });
    }

    var row = document.createElement('tr');
    cells.forEach(function (spec) {
      var th = document.createElement('th');
      th.className = spec.className;
      th.textContent = spec.text;
      if (spec.title) th.title = spec.title;
      row.appendChild(th);
    });
    return row;
  }

  // Both K/D columns render the same way: your kills on them, then your deaths
  // to them, coloured rather than labelled (green = you, red = them) so the
  // pair fits a narrow column. Blank when nothing has happened either way —
  // in a column layout an empty cell reads better than a "0–0" that looks like
  // real data.
  function buildKdCell(kills, deaths, whenLabel) {
    var cell = document.createElement('td');
    cell.className = 'kd-cell';
    if (!kills && !deaths) return cell;

    cell.innerHTML = '<span class="kd-num kd-you">' + kills +
      '</span>/<span class="kd-num kd-them">' + deaths + '</span>';
    cell.title = 'You killed them ' + kills + ', they killed you ' + deaths + ', ' + whenLabel;
    return cell;
  }

  function buildRow(player) {
    var row = document.createElement('tr');
    row.className = player.is_teammate ? 'teammate' : 'enemy';

    var iconCell = document.createElement('td');
    iconCell.className = 'icon-cell';
    iconCell.appendChild(buildIcon(player.hero_name));
    row.appendChild(iconCell);

    var nameCell = document.createElement('td');
    nameCell.className = 'name-cell';
    var nameLine = document.createElement('div');
    nameLine.className = 'name-line';
    nameLine.textContent = player.display_name;
    nameCell.appendChild(nameLine);
    // Both K/D figures used to live here as sub-lines under the name; they have
    // their own columns now (2026-09-06 ask), leaving the name cell for the two
    // things that are prose rather than numbers.
    // "3 matches ago · 5d ago" (plan §11, 2026-09-06) — nothing to show on a
    // brand-new player (recency is null when there's no prior sighting at all).
    var recency = recencyText(player.recency);
    if (recency) {
      var recencyLine = document.createElement('div');
      recencyLine.className = 'sub-line';
      recencyLine.textContent = recency;
      nameCell.appendChild(recencyLine);
    }
    // Which side they were on last time (2026-09-06 ask). Sits where the
    // most-played hero used to: that moved into the hero column, where it
    // belongs next to the other hero it's compared against.
    if (player.last_side === true || player.last_side === false) {
      var sideLine = document.createElement('div');
      sideLine.className = 'sub-line';
      sideLine.textContent = player.last_side ? 'Last time: on your team' : 'Last time: against you';
      nameCell.appendChild(sideLine);
    }
    // Your own tags and note on them, from the History window. User text, so
    // built as text nodes only.
    var tags = player.tags || [];
    if (tags.length || player.note) {
      var notesLine = document.createElement('div');
      notesLine.className = 'sub-line notes-line';
      tags.forEach(function (tag) {
        var chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = tag;
        notesLine.appendChild(chip);
      });
      if (player.note) {
        var noteEl = document.createElement('span');
        noteEl.className = 'note-text';
        noteEl.textContent = player.note.short;
        noteEl.title = player.note.full;
        notesLine.appendChild(noteEl);
      }
      nameCell.appendChild(notesLine);
    }
    row.appendChild(nameCell);

    if (columns.lastHero) {
      var lastHeroCell = document.createElement('td');
      lastHeroCell.className = 'last-hero-cell';
      // only worth showing when it differs from what they're on right now —
      // "last time: same hero" isn't information. Unlike the main icon column, an
      // unresolvable name gets nothing rather than a "?" placeholder: there, "?"
      // usefully marks a player whose current hero we can't name; here it's just
      // a grey box that says less than empty space does.
      var lastHeroPath = player.last_hero && player.last_hero !== player.hero_name ?
        DejaVuHeroIcons.resolve(player.last_hero) : null;
      if (lastHeroPath) {
        lastHeroCell.appendChild(buildIcon(player.last_hero, 'Last time: ' + player.last_hero));
      } else {
        // Holds the slot open so the most-played icon below never slides left
        // into the last-played position. Without it the two are the same size
        // in the same cell and the only thing telling them apart is the count
        // label, which is easy to miss at a glance.
        var slot = document.createElement('span');
        slot.className = 'hero-slot-empty';
        lastHeroCell.appendChild(slot);
      }
      // Hero picked most often across every sighting including mid-match swaps
      // (2026-09-06 ask: moved here from under the name). It belongs beside the
      // last-played hero rather than in the name cell — both answer "which
      // hero", so putting them together lets you read one against the other,
      // and it keeps the name column to text. Rendered as its own icon with the
      // pick count beneath, and skipped when it's the same hero the last-played
      // icon is already showing, for the same reason that icon skips a repeat
      // of the current hero.
      var mostPlayed = player.most_played_hero;
      if (mostPlayed && DejaVuHeroIcons.resolve(mostPlayed.name) && mostPlayed.name !== player.last_hero) {
        var mostPlayedWrap = document.createElement('div');
        mostPlayedWrap.className = 'most-played';
        mostPlayedWrap.appendChild(buildIcon(mostPlayed.name,
          'Most often on ' + mostPlayed.name + ' (' + mostPlayed.count + ' picks)'));
        var countLabel = document.createElement('div');
        countLabel.className = 'most-played-count';
        countLabel.textContent = mostPlayed.count + 'x';
        mostPlayedWrap.appendChild(countLabel);
        lastHeroCell.appendChild(mostPlayedWrap);
      }
      row.appendChild(lastHeroCell);
    }

    var countCell = document.createElement('td');
    countCell.className = 'count-cell';
    countCell.textContent = player.times_played_together + 'x';
    row.appendChild(countCell);

    if (columns.matchKD) {
      row.appendChild(buildKdCell(player.match_kills, player.match_deaths, 'this match'));
    }
    if (columns.lifetimeKD) {
      row.appendChild(buildKdCell(player.kills_on_them, player.deaths_to_them, 'before this match'));
    }

    if (columns.record) {
      row.appendChild(buildRecordCell(player.record_with, 'With them on your team'));
      row.appendChild(buildRecordCell(player.record_against, 'Against them'));
    }

    return row;
  }

  function buildIcon(heroName, title) {
    var path = DejaVuHeroIcons.resolve(heroName);
    if (path) {
      var img = document.createElement('img');
      img.src = path;
      img.alt = heroName;
      if (title) img.title = title;
      return img;
    }
    var placeholder = document.createElement('div');
    placeholder.className = 'icon-placeholder';
    placeholder.textContent = '?';
    if (title) placeholder.title = title;
    return placeholder;
  }

  init();
})();
