// Overlay Renderer (see DEJAVU_OW_PLAN.md §6.1, §7) — dumb display layer.
// All recognition/counting logic lives in the background window; this just
// re-renders the full player table whenever a 'players-update' message
// arrives with the current match's roster (background resends the whole list
// on any change rather than patching individual rows), and updates the
// current match's own result banner on 'match-result'.

(function () {
  var tableEl, rowsEl, emptyEl, matchResultEl;

  function init() {
    tableEl = document.getElementById('table');
    rowsEl = document.getElementById('rows');
    emptyEl = document.getElementById('empty');
    matchResultEl = document.getElementById('match-result');
    overwolf.windows.onMessageReceived.addListener(handleMessage);
  }

  function handleMessage(message) {
    if (message.id === 'players-update') {
      render(message.content.players || []);
    }
    if (message.id === 'match-result') {
      renderMatchResult(message.content.result);
    }
  }

  // result: "victory" | "defeat" | "draw" | null (confirmed against real
  // matches — GEP gives these as strings, not a boolean)
  function resultBadge(result) {
    if (result === 'victory') return { text: 'W', className: 'victory' };
    if (result === 'defeat') return { text: 'L', className: 'defeat' };
    if (result === 'draw') return { text: 'D', className: 'draw' };
    return null;
  }

  function renderMatchResult(result) {
    var badge = resultBadge(result);
    if (!badge) {
      matchResultEl.style.display = 'none';
      matchResultEl.className = '';
      matchResultEl.textContent = '';
      return;
    }
    matchResultEl.style.display = '';
    matchResultEl.className = badge.className;
    matchResultEl.textContent = result;
  }

  function render(players) {
    rowsEl.innerHTML = '';

    if (!players.length) {
      emptyEl.style.display = '';
      tableEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    tableEl.style.display = '';
    players.forEach(function (player) {
      rowsEl.appendChild(buildRow(player));
    });
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
    nameCell.textContent = player.display_name;
    row.appendChild(nameCell);

    var lastHeroCell = document.createElement('td');
    lastHeroCell.className = 'last-hero-cell';
    // only worth showing when it differs from what they're on right now —
    // "last time: same hero" isn't information
    if (player.last_hero && player.last_hero !== player.hero_name) {
      lastHeroCell.appendChild(buildIcon(player.last_hero, 'Last time: ' + player.last_hero));
    }
    row.appendChild(lastHeroCell);

    var countCell = document.createElement('td');
    countCell.className = 'count-cell';
    countCell.textContent = player.times_played_together + 'x';
    row.appendChild(countCell);

    var resultCell = document.createElement('td');
    var badge = resultBadge(player.last_result);
    resultCell.className = 'result-cell' + (badge ? ' ' + badge.className : '');
    resultCell.textContent = badge ? badge.text : '';
    row.appendChild(resultCell);

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
