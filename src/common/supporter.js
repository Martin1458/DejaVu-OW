// Account ownership stays in memory, separate from cosmetic preferences.
// Endpoint contract: https://dev.overwolf.com/ow-native/reference/subscriptions-api/
var DejaVuSupporter = (function () {
  var config = DejaVuSupporterConfig;
  var state = { status: 'setup', owned: false, userId: null };
  var listeners = [], revision = 0, started = false;
  var verifiedAt = 0;
  var GRACE_MS = 24 * 60 * 60 * 1000;

  function configured() {
    return !!config.storeId && config.packageIds.length > 0;
  }
  function notify() { listeners.forEach(function (fn) { fn(snapshot()); }); }
  function snapshot() {
    return { status: state.status, owned: state.owned, userId: state.userId,
      canPurchase: configured() && config.salesEnabled && !!state.userId &&
        !state.owned && state.status === 'ready' };
  }
  function call(method) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timeout')); }, 10000);
      try { method(function (result) { clearTimeout(timer); resolve(result); }); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
  }
  function request(path, token) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    return fetch('https://subscriptions-api.overwolf.com' + path, {
      headers: { Authorization: 'Bearer ' + token }, signal: controller.signal,
      cache: 'no-store'
    }).then(function (response) {
      if (!response.ok) {
        var error = new Error('request failed');
        error.unauthorized = response.status === 401 || response.status === 403;
        throw error;
      }
      return response.json();
    }).finally(function () { clearTimeout(timer); });
  }
  function refresh() {
    var run = ++revision;
    if (!configured()) {
      state = { status: 'setup', owned: false, userId: null };
      notify();
      return Promise.resolve(snapshot());
    }
    state.status = 'checking'; notify();
    return call(function (done) { overwolf.profile.getCurrentUser(done); }).then(function (user) {
      if (run !== revision) return;
      if (!user || !user.success || !user.uuid) {
        verifiedAt = 0;
        state = { status: 'login', owned: false, userId: null };
        return;
      }
      if (state.userId !== user.uuid) { state.owned = false; verifiedAt = 0; }
      state.userId = user.uuid;
      return call(function (done) { overwolf.profile.generateUserSessionToken(done); }).then(function (auth) {
        if (run !== revision) return;
        if (!auth || !auth.success || !auth.token) throw new Error('authentication unavailable');
        var extensionId = location.hostname;
        return request('/subscriptions/' + encodeURIComponent(config.storeId) +
          '?extensionId=' + encodeURIComponent(extensionId), auth.token);
      }).then(function (rows) {
        if (run !== revision) return;
        if (!Array.isArray(rows)) throw new Error('unexpected ownership response');
        if (rows.some(function (row) {
          return !row || typeof row.packageId === 'undefined' || typeof row.state !== 'string';
        })) throw new Error('unexpected ownership response');
        state.owned = rows.some(function (row) {
          return row.userId === user.uuid && config.packageIds.some(function (id) {
            return String(id) === String(row.packageId);
          }) && (row.state === 'ACTIVE' || row.state === 'PENDING_CANCELLATION');
        });
        verifiedAt = Date.now();
        state.status = 'ready';
      });
    }).catch(function (error) {
      if (run !== revision) return;
      // Grace is session-only and never survives an account change or explicit denial.
      if (error.unauthorized || Date.now() - verifiedAt > GRACE_MS) state.owned = false;
      state.status = 'error';
    }).then(function () {
      if (run === revision) notify();
      return snapshot();
    });
  }
  function start() {
    if (started) return;
    started = true;
    if (overwolf.profile && overwolf.profile.onLoginStateChanged) {
      overwolf.profile.onLoginStateChanged.addListener(function () {
        // Invalidate old requests and access before resolving the current account.
        ++revision; verifiedAt = 0;
        state = { status: 'checking', owned: false, userId: null };
        notify(); refresh();
      });
    }
    window.addEventListener('focus', refresh);
    setInterval(refresh, 5 * 60 * 1000);
    refresh();
  }
  function checkout() {
    // Recheck immediately before purchase to prevent stale-user checkout.
    return refresh().then(function (current) {
      if (!current.canPurchase) return false;
      var url = 'https://subscriptions-api.overwolf.com/checkout/' +
        encodeURIComponent(config.storeId) + '/' + encodeURIComponent(config.packageIds[0]) +
        '?extensionId=' + encodeURIComponent(location.hostname) +
        '&userId=' + encodeURIComponent(current.userId);
      overwolf.utils.openUrlInDefaultBrowser(url);
      return true;
    });
  }
  return {
    start: start, refresh: refresh, checkout: checkout, snapshot: snapshot,
    hasAccess: function () { return state.owned && Date.now() - verifiedAt <= GRACE_MS; },
    watch: function (fn) { listeners.push(fn); fn(snapshot()); },
    previewAllowed: function () { return config.allowPreview && !config.salesEnabled; }
  };
})();