// Maps GEP's hero_name (concatenated, no separators — e.g. "JETPACKCAT",
// "SOLDIER76") to a hero portrait in /images. Matches by normalizing both the
// filename and the incoming hero_name down to bare lowercase alphanumerics
// rather than hand-maintaining a name -> file table, so it keeps working as
// heroes get added to /images without needing a code change here.

var DejaVuHeroIcons = (function () {
  var IMAGES_DIR = '../../images/';

  var FILENAMES = [
    'Ana_Hero.png', 'Anran_Hero.png', 'Ashe_Hero.png', 'Baptiste_Hero.png',
    'Bastion_Hero.png', 'Brigitte_Hero.png', 'Cassidy_Hero.png', 'Dmon_Hero.png',
    'Doctrine_Hero.png', 'Domina_Hero.png', 'Doomfist_Hero.png', 'Dva_Hero.png', 'Echo_Hero.png',
    'Emre_Hero.png', 'Freja_Hero.png', 'Genji_Hero.png', 'Hanzo_Hero.png',
    'Hazard_Hero.png', 'Illari_Hero.png', 'Jetpack_Cat_Hero.png', 'Junker_Queen_Hero.png',
    'Junkrat_Hero.png', 'Juno_Hero.png', 'Kiriko_Hero.png', 'Lifeweaver_Hero.png',
    'Lucio_Hero.png', 'Mauga_Hero.png', 'Mei_Hero.png', 'Mercy_Hero.png',
    'Mizuki_Hero.png', 'Moira_Hero.png', 'Orisa_Hero.png', 'Pharah_Hero.png',
    'Ramattra_Hero.png', 'Reaper_Hero.png', 'Reinhardt_Hero.png', 'Roadhog_Hero.png',
    'Shion_Hero.png', 'Sierra_Hero.png', 'Sigma_Hero.png', 'Sojourn_Hero.png',
    'Soldier_76_Hero.png', 'Sombra_Hero.png', 'Symmetra_Hero.png', 'Torbjorn_Hero.png',
    'Tracer_Hero.png', 'Vendetta_Hero.png', 'Venture_Hero.png', 'Widowmaker_Hero.png',
    'Winston_Hero.png', 'Wrecking_Ball_Hero.png', 'Wuyang_Hero.png', 'Zarya_Hero.png',
    'Zenyatta_Hero.png'
  ];

  function normalize(str) {
    return (str || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  }

  var byNormalizedName = {};
  FILENAMES.forEach(function (filename) {
    var key = normalize(filename.replace(/_Hero\.png$/, ''));
    byNormalizedName[key] = filename;
  });

  // Returns a relative image path, or null if hero_name is missing/unresolved
  // (e.g. "UNKNOWN", or null before GEP resolves it) or just not in /images yet.
  function resolve(heroName) {
    var filename = byNormalizedName[normalize(heroName)];
    return filename ? IMAGES_DIR + filename : null;
  }

  return { resolve: resolve };
})();
