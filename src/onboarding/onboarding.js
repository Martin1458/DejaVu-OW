// Onboarding popup (plan §11, 2026-09-05 ask) — a one-time nudge shown by
// background.js the first time Overwatch is detected running while
// DejaVuSettings.isSetupComplete() is still false. Doesn't gate recording
// (Basic tier already applies by default) — just invites the user to
// consciously look at what's tracked/shown at least once, per their own
// request not to silently accumulate history under an unreviewed default.

(function () {
  function logDiag(line) {
    console.log('[DejaVuOnboarding] ' + line);
    if (window.DejaVuFileLog) DejaVuFileLog.log('[onboarding] ' + line);
  }

  function init() {
    DejaVuFileLog.init();
    logDiag('onboarding window shown');

    document.getElementById('open-settings-btn').addEventListener('click', function () {
      logDiag('open-settings clicked');
      DejaVuSettings.markSetupComplete();
      DejaVuWindows.show('history');
      DejaVuWindows.hide('onboarding');
    });

    document.getElementById('keep-defaults-btn').addEventListener('click', function () {
      logDiag('keep-defaults clicked');
      DejaVuSettings.markSetupComplete();
      DejaVuWindows.hide('onboarding');
    });
  }

  init();
})();
