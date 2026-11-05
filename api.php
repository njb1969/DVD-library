<?php
/*
 * DVD Library — JSON API
 *
 * Single endpoint: api.php?action=<name>
 *   status   GET   app state (configured? signed in? TMDB key present?)      — no sign-in needed
 *   login    POST  {password}                                                — no sign-in needed
 *   logout   POST
 *   list     GET   every disc in the library
 *   search   GET   q, type (multi|movie|tv), year   → TMDB matches
 *   barcode  GET   code → library match, product title (UPCitemdb, cached), TMDB matches
 *   save     POST  {id?, tmdb?:{media_type,id}, manual?:{...}, fields:{...}, photo?, remove_photo?}
 *   delete   POST  {id}
 *   refresh  POST  {id}   re-download TMDB details
 *   export   GET   CSV download of the whole library
 *
 * Storage: SQLite file in data_dir (see config.php). Cover photos in covers_dir.
 * TMDB/UPCitemdb are only ever called from here, so the TMDB key never reaches the browser.
 * Written to run on PHP 7.4 or newer with pdo_sqlite and curl (both standard on cPanel).
 */
declare(strict_types=1);

const APP_VERSION = '1.0.0';
const AUTH_COOKIE = 'dvdlib_auth';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

set_exception_handler(function (Throwable $e) {
    error_log('[dvdlib] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode(['ok' => false, 'error' => 'Server error: ' . $e->getMessage()]);
    exit;
});

// ───────────────────────────── configuration ─────────────────────────────

$CONFIG_DEFAULTS = [
    'tmdb_key'              => '',
    'app_password'          => '',
    'upcitemdb_enabled'     => true,
    'certification_country' => 'AU',
    'language'              => 'en-US',
    'data_dir'              => __DIR__ . '/data',
    'covers_dir'            => __DIR__ . '/covers',
    // Service base URLs (overridable only so the app can be tested offline).
    'tmdb_base'             => 'https://api.themoviedb.org/3',
    'upcitemdb_base'        => 'https://api.upcitemdb.com/prod/trial',
];

$CFG = null;
if (is_file(__DIR__ . '/config.php')) {
    $loaded = require __DIR__ . '/config.php';
    if (is_array($loaded)) {
        $CFG = array_merge($CONFIG_DEFAULTS, $loaded);
    }
}

function cfg(string $key)
{
    global $CFG;
    return $CFG[$key] ?? null;
}

// ───────────────────────────── response helpers ─────────────────────────────

function respond(array $data, int $status = 200): void
{
    http_response_code($status);
    echo json_encode(['ok' => true] + $data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $status = 400, array $extra = []): void
{
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $message] + $extra, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function body(): array
{
    static $parsed = null;
    if ($parsed === null) {
        $raw = file_get_contents('php://input');
        $parsed = ($raw !== false && $raw !== '') ? json_decode($raw, true) : [];
        if (!is_array($parsed)) {
            fail('Request body must be JSON.', 400);
        }
    }
    return $parsed;
}

// ───────────────────────────── paths ─────────────────────────────

function data_dir(): string
{
    $dir = rtrim((string)cfg('data_dir'), '/');
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        fail('Cannot create the data folder (' . $dir . '). Check folder permissions.', 500);
    }
    return $dir;
}

function covers_dir(): string
{
    $dir = rtrim((string)cfg('covers_dir'), '/');
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        fail('Cannot create the covers folder (' . $dir . '). Check folder permissions.', 500);
    }
    return $dir;
}

/** URL (relative to index.html) where cover photos are served from. */
function covers_url(): string
{
    $app = realpath(__DIR__);
    $covers = realpath(covers_dir());
    if ($app && $covers && strncmp($covers, $app . DIRECTORY_SEPARATOR, strlen($app) + 1) === 0) {
        return str_replace(DIRECTORY_SEPARATOR, '/', substr($covers, strlen($app) + 1)) . '/';
    }
    return 'covers/';
}

// ───────────────────────────── database ─────────────────────────────

function db(): PDO
{
    static $pdo = null;
    if ($pdo) {
        return $pdo;
    }
    $pdo = new PDO('sqlite:' . data_dir() . '/library.sqlite');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $pdo): void
{
    $version = (int)$pdo->query('PRAGMA user_version')->fetchColumn();
    if ($version < 1) {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS items (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                media_type     TEXT NOT NULL DEFAULT 'movie',  -- movie | tv | other
                tmdb_id        INTEGER,
                imdb_id        TEXT,
                title          TEXT NOT NULL,
                original_title TEXT,
                year           INTEGER,
                overview       TEXT,
                genres         TEXT,
                directors      TEXT,
                cast_list      TEXT,
                runtime        INTEGER,
                certification  TEXT,
                rating         REAL,
                poster_path    TEXT,
                backdrop_path  TEXT,
                collection     TEXT,
                format         TEXT NOT NULL DEFAULT 'DVD',
                barcode        TEXT,
                location       TEXT,
                season         TEXT,
                discs          INTEGER,
                notes          TEXT,
                loaned_to      TEXT,
                cover_photo    TEXT,
                use_photo      INTEGER NOT NULL DEFAULT 0,
                added_at       TEXT NOT NULL,
                updated_at     TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
            CREATE INDEX IF NOT EXISTS idx_items_tmdb ON items(media_type, tmdb_id);

            CREATE TABLE IF NOT EXISTS barcode_cache (
                barcode       TEXT PRIMARY KEY,
                product_title TEXT,
                status        TEXT NOT NULL,   -- found | notfound
                source        TEXT,
                looked_up_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
        ");
        $pdo->exec('PRAGMA user_version = 1');
    }
}

function meta_get(string $key): ?string
{
    $st = db()->prepare('SELECT value FROM meta WHERE key = ?');
    $st->execute([$key]);
    $v = $st->fetchColumn();
    return $v === false ? null : (string)$v;
}

function meta_set(string $key, ?string $value): void
{
    db()->prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
        ->execute([$key, $value]);
}

function now_iso(): string
{
    return gmdate('Y-m-d\TH:i:s\Z');
}

// ───────────────────────────── sign-in ─────────────────────────────

function is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    if (strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https') {
        return true;
    }
    return (string)($_SERVER['SERVER_PORT'] ?? '') === '443';
}

function cookie_path(): string
{
    $dir = str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/api.php')));
    return rtrim($dir, '/') . '/';
}

function server_secret(): string
{
    $file = data_dir() . '/secret.key';
    if (!is_file($file)) {
        file_put_contents($file, bin2hex(random_bytes(32)), LOCK_EX);
        @chmod($file, 0600);
    }
    return trim((string)file_get_contents($file));
}

function auth_token(): string
{
    // Tied to the current password: changing app_password signs every device out.
    return hash_hmac('sha256', 'dvdlib|' . hash('sha256', (string)cfg('app_password')), server_secret());
}

function is_authed(): bool
{
    $cookie = (string)($_COOKIE[AUTH_COOKIE] ?? '');
    return $cookie !== '' && hash_equals(auth_token(), $cookie);
}

function set_auth_cookie(bool $signIn): void
{
    setcookie(AUTH_COOKIE, $signIn ? auth_token() : '', [
        'expires'  => $signIn ? time() + 400 * 86400 : time() - 3600,
        'path'     => cookie_path(),
        'secure'   => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

// ───────────────────────────── HTTP client ─────────────────────────────

/** @return array{0:int,1:?array} HTTP status (0 = network failure) and decoded JSON. */
function http_get_json(string $url, array $headers = [], int $timeout = 15): array
{
    $headers[] = 'Accept: application/json';
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 3,
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_USERAGENT      => 'DVDLibrary/' . APP_VERSION,
            CURLOPT_ENCODING       => '',
        ]);
        $raw = curl_exec($ch);
        $status = $raw === false ? 0 : (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
    } else {
        $ctx = stream_context_create(['http' => [
            'method'        => 'GET',
            'header'        => implode("\r\n", $headers),
            'timeout'       => $timeout,
            'ignore_errors' => true,
            'user_agent'    => 'DVDLibrary/' . APP_VERSION,
        ]]);
        $raw = @file_get_contents($url, false, $ctx);
        $status = 0;
        foreach ($http_response_header ?? [] as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
                $status = (int)$m[1];
            }
        }
    }
    $json = is_string($raw) ? json_decode($raw, true) : null;
    return [$status, is_array($json) ? $json : null];
}

// ───────────────────────────── TMDB ─────────────────────────────

function tmdb_enabled(): bool
{
    return trim((string)cfg('tmdb_key')) !== '';
}

function tmdb_get(string $path, array $params = []): array
{
    if (!tmdb_enabled()) {
        fail('No TMDB key in config.php, so online lookups are switched off. You can still add discs by hand.', 503);
    }
    $key = trim((string)cfg('tmdb_key'));
    $headers = [];
    if (strncmp($key, 'eyJ', 3) === 0) {
        $headers[] = 'Authorization: Bearer ' . $key;      // v4 read access token
    } else {
        $params['api_key'] = $key;                          // v3 API key
    }
    $url = rtrim((string)cfg('tmdb_base'), '/') . $path . '?' . http_build_query($params);
    [$status, $json] = http_get_json($url, $headers);
    if ($status === 401) {
        fail('TMDB rejected the key. Check tmdb_key in config.php.', 502);
    }
    if ($status === 404) {
        fail('TMDB has no record with that ID.', 404);
    }
    if ($status === 429) {
        fail('TMDB says we are going too fast. Wait a few seconds and try again.', 503);
    }
    if ($status !== 200 || $json === null) {
        fail('Could not reach TMDB (HTTP ' . $status . '). Check the server has internet access.', 502);
    }
    return $json;
}

function year_of(?string $date): ?int
{
    return ($date && preg_match('/^(\d{4})/', $date, $m)) ? (int)$m[1] : null;
}

function shorten(?string $text, int $max): string
{
    $text = trim((string)$text);
    if (mb_strlen($text) <= $max) {
        return $text;
    }
    return rtrim(mb_substr($text, 0, $max - 1)) . '…';
}

/** Normalise a TMDB search hit into the shape the front end uses. */
function tmdb_hit(array $r, string $type): array
{
    return [
        'media_type'     => $type,
        'tmdb_id'        => (int)$r['id'],
        'title'          => (string)($type === 'tv' ? ($r['name'] ?? '') : ($r['title'] ?? '')),
        'original_title' => (string)($type === 'tv' ? ($r['original_name'] ?? '') : ($r['original_title'] ?? '')),
        'year'           => year_of($type === 'tv' ? ($r['first_air_date'] ?? null) : ($r['release_date'] ?? null)),
        'overview'       => shorten($r['overview'] ?? '', 260),
        'poster_path'    => $r['poster_path'] ?? null,
        'popularity'     => (float)($r['popularity'] ?? 0),
    ];
}

/**
 * Search TMDB. $type: multi | movie | tv. Results with a matching year float to the top.
 * @return array<int,array>
 */
function tmdb_search(string $query, string $type = 'multi', ?int $year = null): array
{
    $query = trim($query);
    if ($query === '') {
        return [];
    }
    $base = ['query' => $query, 'include_adult' => 'false', 'language' => cfg('language'), 'page' => 1];
    $hits = [];
    if ($type === 'movie') {
        $p = $base + ($year ? ['year' => $year] : []);
        foreach (tmdb_get('/search/movie', $p)['results'] ?? [] as $r) {
            $hits[] = tmdb_hit($r, 'movie');
        }
        if (!$hits && $year) {   // year on the box is sometimes the disc release, not the film
            foreach (tmdb_get('/search/movie', $base)['results'] ?? [] as $r) {
                $hits[] = tmdb_hit($r, 'movie');
            }
        }
    } elseif ($type === 'tv') {
        foreach (tmdb_get('/search/tv', $base)['results'] ?? [] as $r) {
            $hits[] = tmdb_hit($r, 'tv');
        }
    } else {
        foreach (tmdb_get('/search/multi', $base)['results'] ?? [] as $r) {
            $mt = $r['media_type'] ?? '';
            if ($mt === 'movie' || $mt === 'tv') {
                $hits[] = tmdb_hit($r, $mt);
            }
        }
    }
    if ($year) {
        // Stable sort: exact year first, then within one year, then the rest (TMDB relevance order kept).
        $ranked = [];
        foreach ($hits as $i => $h) {
            $d = $h['year'] === null ? 99 : abs($h['year'] - $year);
            $ranked[] = [$d === 0 ? 0 : ($d <= 1 ? 1 : 2), $i, $h];
        }
        usort($ranked, function ($a, $b) {
            return [$a[0], $a[1]] <=> [$b[0], $b[1]];
        });
        $hits = array_column($ranked, 2);
    }
    return array_slice($hits, 0, 20);
}

/** Search, retrying with a shorter title if the full one finds nothing. */
function smart_search(string $title, ?int $year, string $type = 'multi'): array
{
    $tries = [$title];
    foreach ([':', ' - ', ' – '] as $sep) {
        if (strpos($title, $sep) !== false) {
            $tries[] = trim(explode($sep, $title)[0]);
        }
    }
    foreach (array_unique($tries) as $t) {
        if (mb_strlen($t) < 2) {
            continue;
        }
        $hits = tmdb_search($t, $type, $year);
        if (!$hits && $type === 'tv') {
            $hits = tmdb_search($t, 'multi', $year);
        }
        if ($hits) {
            return $hits;
        }
    }
    return [];
}

/** Full details for one title, flattened into item columns. */
function tmdb_details(string $type, int $id): array
{
    $country = strtoupper((string)cfg('certification_country'));
    if ($type === 'tv') {
        $d = tmdb_get('/tv/' . $id, ['language' => cfg('language'), 'append_to_response' => 'credits,content_ratings,external_ids']);
        $cert = '';
        foreach ($d['content_ratings']['results'] ?? [] as $r) {
            if (($r['iso_3166_1'] ?? '') === $country && !empty($r['rating'])) {
                $cert = (string)$r['rating'];
                break;
            }
        }
        return [
            'media_type'     => 'tv',
            'tmdb_id'        => (int)$d['id'],
            'imdb_id'        => $d['external_ids']['imdb_id'] ?? null,
            'title'          => (string)($d['name'] ?? ''),
            'original_title' => $d['original_name'] ?? null,
            'year'           => year_of($d['first_air_date'] ?? null),
            'overview'       => $d['overview'] ?? null,
            'genres'         => implode(', ', array_column($d['genres'] ?? [], 'name')),
            'directors'      => implode(', ', array_column($d['created_by'] ?? [], 'name')),
            'cast_list'      => implode(', ', array_slice(array_column($d['credits']['cast'] ?? [], 'name'), 0, 10)),
            'runtime'        => isset($d['episode_run_time'][0]) ? (int)$d['episode_run_time'][0] : null,
            'certification'  => $cert,
            'rating'         => isset($d['vote_average']) ? round((float)$d['vote_average'], 1) : null,
            'poster_path'    => $d['poster_path'] ?? null,
            'backdrop_path'  => $d['backdrop_path'] ?? null,
            'collection'     => null,
        ];
    }

    $d = tmdb_get('/movie/' . $id, ['language' => cfg('language'), 'append_to_response' => 'credits,release_dates']);
    $cert = '';
    foreach ($d['release_dates']['results'] ?? [] as $r) {
        if (($r['iso_3166_1'] ?? '') !== $country) {
            continue;
        }
        foreach ($r['release_dates'] ?? [] as $rd) {
            if (!empty($rd['certification'])) {
                $cert = (string)$rd['certification'];
                break 2;
            }
        }
    }
    $directors = [];
    foreach ($d['credits']['crew'] ?? [] as $c) {
        if (($c['job'] ?? '') === 'Director') {
            $directors[$c['name']] = true;
        }
    }
    return [
        'media_type'     => 'movie',
        'tmdb_id'        => (int)$d['id'],
        'imdb_id'        => $d['imdb_id'] ?? null,
        'title'          => (string)($d['title'] ?? ''),
        'original_title' => $d['original_title'] ?? null,
        'year'           => year_of($d['release_date'] ?? null),
        'overview'       => $d['overview'] ?? null,
        'genres'         => implode(', ', array_column($d['genres'] ?? [], 'name')),
        'directors'      => implode(', ', array_keys($directors)),
        'cast_list'      => implode(', ', array_slice(array_column($d['credits']['cast'] ?? [], 'name'), 0, 10)),
        'runtime'        => !empty($d['runtime']) ? (int)$d['runtime'] : null,
        'certification'  => $cert,
        'rating'         => isset($d['vote_average']) ? round((float)$d['vote_average'], 1) : null,
        'poster_path'    => $d['poster_path'] ?? null,
        'backdrop_path'  => $d['backdrop_path'] ?? null,
        'collection'     => $d['belongs_to_collection']['name'] ?? null,
    ];
}

// ───────────────────────────── barcodes ─────────────────────────────

function digits_only(string $s): string
{
    return preg_replace('/\D+/', '', $s) ?? '';
}

/** Check digit test for EAN-8, UPC-A (12) and EAN-13. */
function barcode_checksum_ok(string $code): bool
{
    $n = strlen($code);
    if (!in_array($n, [8, 12, 13], true)) {
        return false;
    }
    $sum = 0;
    for ($i = 0; $i < $n - 1; $i++) {
        // Weights alternate 3,1 counting back from the digit before the check digit.
        $sum += (int)$code[$i] * ((($n - 1 - $i) % 2 === 1) ? 3 : 1);
    }
    return ((10 - $sum % 10) % 10) === (int)$code[$n - 1];
}

/** A UPC-A and its 0-prefixed EAN-13 are the same product. */
function barcode_variants(string $code): array
{
    $v = [$code];
    if (strlen($code) === 12) {
        $v[] = '0' . $code;
    } elseif (strlen($code) === 13 && $code[0] === '0') {
        $v[] = substr($code, 1);
    }
    return $v;
}

/**
 * Turn a retail product title into something TMDB can search, plus hints.
 * "The Matrix (DVD, 1999, Widescreen) Region 4" → title "The Matrix", year 1999, format DVD.
 */
function clean_product_title(string $raw): array
{
    $t = ' ' . $raw . ' ';
    $format = 'DVD';
    if (preg_match('/\b(4K|UHD|Ultra\s*HD)\b/i', $t)) {
        $format = '4K UHD';
    } elseif (preg_match('/\bblu[\s-]?ray\b/i', $t)) {
        $format = 'Blu-ray';
    }
    $season = null;
    $ordinals = ['first' => 1, 'second' => 2, 'third' => 3, 'fourth' => 4, 'fifth' => 5, 'sixth' => 6, 'seventh' => 7,
        'eighth' => 8, 'ninth' => 9, 'tenth' => 10, 'one' => 1, 'two' => 2, 'three' => 3, 'four' => 4, 'five' => 5,
        'six' => 6, 'seven' => 7, 'eight' => 8, 'nine' => 9, 'ten' => 10];
    $ordRe = implode('|', array_keys($ordinals));
    if (preg_match('/\b(?:season|series)\s*(\d{1,2})\b/i', $t, $m)) {
        $season = (string)(int)$m[1];
    } elseif (preg_match('/\b(?:season|series)\s+(' . $ordRe . ')\b/i', $t, $m)
        || preg_match('/\b(' . $ordRe . ')\s+(?:season|series)\b/i', $t, $m)) {
        $season = (string)$ordinals[strtolower($m[1])];
    } elseif (preg_match('/\bcomplete\s+(?:series|collection|seasons?)\b/i', $t)) {
        $season = 'Complete';
    }
    $year = null;
    if (preg_match('/\b(19[2-9]\d|20[0-4]\d)\b/', $t, $m)) {
        $year = (int)$m[1];
    }

    $t = preg_replace('/[\(\[\{][^\)\]\}]*[\)\]\}]/', ' ', $t);            // anything in brackets is edition info
    // "+ Digital", "+ Blu-ray" and similar bundle add-ons
    $t = preg_replace('/\+\s*(?:digital(?:\s*(?:copy|code|hd))?|ultraviolet|blu[\s-]?ray|dvd|4k(?:\s*ultra\s*hd)?|ultra\s*hd)\b/i', ' ', $t);
    // "The Complete Second Season", "Season Two", "Third Series"
    $t = preg_replace('/\b(?:the\s+)?(?:complete\s+)?(?:' . $ordRe . ')\s+(?:season|series)\b/i', ' ', $t);
    $t = preg_replace('/\b(?:season|series)\s+(?:' . $ordRe . ')\b/i', ' ', $t);
    $noise = [
        'dvd', 'blu[\s-]?ray', '4k', 'uhd', 'ultra\s*hd', 'hd[\s-]?dvd', 'region\s*\d', 'r\d', 'pal', 'ntsc',
        'wide\s*screen', 'full\s*screen', '\d+[\s-]*discs?', 'disc\s*set', 'box\s*set', 'boxset', 'steelbook',
        '(?:special|collector\'?s|limited|deluxe|anniversary|extended|ultimate|definitive|platinum|remastered|theatrical|unrated|director\'?s)\s*(?:edition|cut|version)?',
        'edition', 'digital\s*copy', 'ultraviolet', '\+\s*digital', 'with\s+digital', 'brand\s*new', 'sealed',
        '(?:the\s+)?complete\s+(?:series|collection|seasons?)(?:\s+(?:collection|box\s*set))?', '(?:season|series)\s*\d{1,2}', 'movie', 'film',
        '19[2-9]\d', '20[0-4]\d',
    ];
    $t = preg_replace('/\b(?:' . implode('|', $noise) . ')\b/i', ' ', $t);
    $t = preg_replace('/(?<=\s)\+(?=\s|$)/', ' ', $t);                     // orphaned "+" left behind
    $t = preg_replace('/\s*[-–:|,\/+]+\s*$/u', '', trim($t));               // trailing separators
    $t = preg_replace('/^\s*[-–:|,\/+]+\s*/u', '', $t);                     // leading separators
    $t = preg_replace('/\s{2,}/', ' ', trim($t));
    $t = preg_replace('/\s+([,:])/', '$1', $t);
    $t = trim($t, " \t\n\r\0\x0B-–:|,/+");

    return ['title' => $t !== '' ? $t : trim($raw), 'year' => $year, 'format' => $format, 'season' => $season];
}

/** Ask UPCitemdb (free tier). @return array{status:string,title:?string,message:?string} */
function upcitemdb_lookup(string $code): array
{
    if (!cfg('upcitemdb_enabled')) {
        return ['status' => 'disabled', 'title' => null, 'message' => 'Barcode lookups are switched off in config.php.'];
    }
    $until = (int)(meta_get('upc_paused_until') ?? 0);
    if ($until > time()) {
        return ['status' => 'limit', 'title' => null, 'message' => 'The free barcode lookup allowance is used up for now. Snap the cover or type the title instead.'];
    }
    $url = rtrim((string)cfg('upcitemdb_base'), '/') . '/lookup?upc=' . rawurlencode($code);
    [$status, $json] = http_get_json($url, [], 12);
    $apiCode = strtoupper((string)($json['code'] ?? ''));

    if ($status === 429 || $apiCode === 'EXCEED_LIMIT' || $apiCode === 'TOO_FAST') {
        $pause = $apiCode === 'TOO_FAST' ? 90 : 3 * 3600;
        meta_set('upc_paused_until', (string)(time() + $pause));
        $msg = $apiCode === 'TOO_FAST'
            ? 'Barcode lookups are going too fast. Wait a minute, or snap the cover / type the title.'
            : 'The free barcode lookup allowance (about 100 a day) is used up. Snap the cover or type the title instead.';
        return ['status' => 'limit', 'title' => null, 'message' => $msg];
    }
    if ($status === 200 && !empty($json['items']) && is_array($json['items'])) {
        // Prefer an item that looks like a video product; otherwise the first with a title.
        $best = null;
        foreach ($json['items'] as $it) {
            $title = trim((string)($it['title'] ?? ''));
            if ($title === '') {
                continue;
            }
            $cat = strtolower((string)($it['category'] ?? ''));
            if (strpos($cat, 'dvd') !== false || strpos($cat, 'video') !== false || strpos($cat, 'movie') !== false) {
                $best = $title;
                break;
            }
            $best = $best ?? $title;
        }
        if ($best !== null) {
            return ['status' => 'found', 'title' => $best, 'message' => null];
        }
    }
    if ($status === 200 || $status === 400 || $status === 404 || $apiCode === 'INVALID_UPC' || $apiCode === 'NOT_FOUND') {
        return ['status' => 'notfound', 'title' => null, 'message' => null];
    }
    return ['status' => 'error', 'title' => null, 'message' => 'Barcode lookup service did not answer (HTTP ' . $status . ').'];
}

/** Cached barcode → product title. Hits are kept forever, misses for 30 days. */
function product_title_for(string $code): array
{
    $st = db()->prepare('SELECT * FROM barcode_cache WHERE barcode = ?');
    foreach (barcode_variants($code) as $v) {
        $st->execute([$v]);
        $row = $st->fetch();
        if ($row) {
            if ($row['status'] === 'found') {
                return ['status' => 'found', 'title' => $row['product_title'], 'source' => $row['source'] . ' (cached)', 'message' => null];
            }
            if (strtotime((string)$row['looked_up_at']) > time() - 30 * 86400) {
                return ['status' => 'notfound', 'title' => null, 'source' => 'cache', 'message' => null];
            }
        }
    }
    $r = upcitemdb_lookup($code);
    if ($r['status'] === 'found' || $r['status'] === 'notfound') {
        db()->prepare('INSERT OR REPLACE INTO barcode_cache(barcode, product_title, status, source, looked_up_at) VALUES(?,?,?,?,?)')
            ->execute([$code, $r['title'], $r['status'], 'UPCitemdb', now_iso()]);
    }
    return $r + ['source' => 'UPCitemdb'];
}

/** Remember what a barcode turned out to be, so a rescan later needs no outside lookup. */
function learn_barcode(?string $code, string $title): void
{
    if (!$code) {
        return;
    }
    db()->prepare('INSERT OR REPLACE INTO barcode_cache(barcode, product_title, status, source, looked_up_at) VALUES(?,?,?,?,?)')
        ->execute([$code, $title, 'found', 'your library', now_iso()]);
}

// ───────────────────────────── items ─────────────────────────────

const META_COLUMNS = ['media_type', 'tmdb_id', 'imdb_id', 'title', 'original_title', 'year', 'overview', 'genres',
    'directors', 'cast_list', 'runtime', 'certification', 'rating', 'poster_path', 'backdrop_path', 'collection'];
const USER_COLUMNS = ['format', 'barcode', 'location', 'season', 'discs', 'notes', 'loaned_to', 'use_photo'];

function shape_item(array $r): array
{
    foreach (['id', 'tmdb_id', 'year', 'runtime', 'discs'] as $k) {
        $r[$k] = ($r[$k] === null || $r[$k] === '') ? null : (int)$r[$k];
    }
    $r['rating'] = ($r['rating'] === null || $r['rating'] === '') ? null : (float)$r['rating'];
    $r['use_photo'] = (bool)(int)$r['use_photo'];
    return $r;
}

function get_item(int $id): array
{
    $st = db()->prepare('SELECT * FROM items WHERE id = ?');
    $st->execute([$id]);
    $row = $st->fetch();
    if (!$row) {
        fail('That disc is no longer in the library.', 404);
    }
    return $row;
}

/** Copies already in the library for each TMDB id in $hits, keyed "type:id". */
function owned_map(array $hits): array
{
    $ids = [];
    foreach ($hits as $h) {
        $ids[] = (int)$h['tmdb_id'];
    }
    if (!$ids) {
        return [];
    }
    $in = implode(',', array_fill(0, count($ids), '?'));
    $st = db()->prepare("SELECT id, media_type, tmdb_id, format, location, season FROM items WHERE tmdb_id IN ($in)");
    $st->execute($ids);
    $map = [];
    foreach ($st->fetchAll() as $r) {
        $map[$r['media_type'] . ':' . $r['tmdb_id']][] = [
            'id' => (int)$r['id'], 'format' => $r['format'], 'location' => $r['location'], 'season' => $r['season'],
        ];
    }
    return $map;
}

function with_owned(array $hits): array
{
    $map = owned_map($hits);
    foreach ($hits as &$h) {
        $h['owned'] = $map[$h['media_type'] . ':' . $h['tmdb_id']] ?? [];
    }
    return $hits;
}

function str_field($v, int $max): ?string
{
    if ($v === null) {
        return null;
    }
    $v = trim((string)$v);
    return $v === '' ? null : mb_substr($v, 0, $max);
}

function int_field($v, int $min, int $max): ?int
{
    if ($v === null || $v === '' || !is_numeric($v)) {
        return null;
    }
    $n = (int)$v;
    return ($n < $min || $n > $max) ? null : $n;
}

function save_photo(string $data): string
{
    if (strncmp($data, 'data:', 5) === 0) {
        $data = substr($data, (int)strpos($data, ',') + 1);
    }
    $bin = base64_decode($data, true);
    if ($bin === false || strlen($bin) < 100 || strlen($bin) > 6000000) {
        fail('The cover photo could not be read (too large or damaged).', 400);
    }
    $info = @getimagesizefromstring($bin);
    if (!$info || !in_array($info[2], [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP], true)) {
        fail('The cover photo must be a JPEG, PNG or WebP image.', 400);
    }
    $name = bin2hex(random_bytes(10)) . '.jpg';
    $path = covers_dir() . '/' . $name;
    if (function_exists('imagecreatefromstring')) {
        // Re-encode: guarantees a plain JPEG and strips anything else riding along in the upload.
        $im = @imagecreatefromstring($bin);
        if (!$im) {
            fail('The cover photo could not be decoded.', 400);
        }
        imagejpeg($im, $path, 85);
        imagedestroy($im);
    } else {
        if ($info[2] !== IMAGETYPE_JPEG) {
            fail('This server can only accept JPEG cover photos.', 400);
        }
        file_put_contents($path, $bin, LOCK_EX);
    }
    return $name;
}

function delete_photo(?string $name): void
{
    if ($name && preg_match('/^[a-f0-9]{20}\.jpg$/', $name)) {
        @unlink(covers_dir() . '/' . $name);
    }
}

function action_save(): void
{
    $in = body();
    $id = int_field($in['id'] ?? null, 1, PHP_INT_MAX);
    $existing = $id ? get_item($id) : null;

    // 1. Metadata: from TMDB, typed in by hand, or unchanged.
    $meta = null;
    if (!empty($in['tmdb']['id'])) {
        $type = ($in['tmdb']['media_type'] ?? 'movie') === 'tv' ? 'tv' : 'movie';
        $meta = tmdb_details($type, (int)$in['tmdb']['id']);
        if ($meta['title'] === '') {
            fail('TMDB returned no title for that entry.', 502);
        }
    } elseif (isset($in['manual']) && is_array($in['manual'])) {
        $m = $in['manual'];
        $title = str_field($m['title'] ?? null, 300);
        if (!$title) {
            fail('A title is needed.', 400);
        }
        $mt = (string)($m['media_type'] ?? 'other');
        $meta = [
            'media_type'     => in_array($mt, ['movie', 'tv', 'other'], true) ? $mt : 'other',
            'tmdb_id'        => null,
            'imdb_id'        => null,
            'title'          => $title,
            'original_title' => null,
            'year'           => int_field($m['year'] ?? null, 1880, 2100),
            'overview'       => str_field($m['overview'] ?? null, 4000),
            'genres'         => str_field($m['genres'] ?? null, 300),
            'directors'      => str_field($m['directors'] ?? null, 300),
            'cast_list'      => str_field($m['cast_list'] ?? null, 1000),
            'runtime'        => int_field($m['runtime'] ?? null, 1, 3000),
            'certification'  => str_field($m['certification'] ?? null, 20),
            'rating'         => null,
            'poster_path'    => null,
            'backdrop_path'  => null,
            'collection'     => null,
        ];
    } elseif (!$existing) {
        fail('Choose a match or enter a title.', 400);
    }

    // 2. Your own details about the disc.
    $f = is_array($in['fields'] ?? null) ? $in['fields'] : [];
    $user = $existing ? array_intersect_key($existing, array_flip(USER_COLUMNS)) : [
        'format' => 'DVD', 'barcode' => null, 'location' => null, 'season' => null, 'discs' => null,
        'notes' => null, 'loaned_to' => null, 'use_photo' => 0,
    ];
    if (array_key_exists('format', $f)) {
        $user['format'] = str_field($f['format'], 40) ?? 'DVD';
    }
    if (array_key_exists('barcode', $f)) {
        $bc = digits_only((string)$f['barcode']);
        $user['barcode'] = $bc === '' ? null : substr($bc, 0, 20);
    }
    foreach (['location' => 120, 'season' => 40, 'notes' => 2000, 'loaned_to' => 120] as $k => $max) {
        if (array_key_exists($k, $f)) {
            $user[$k] = str_field($f[$k], $max);
        }
    }
    if (array_key_exists('discs', $f)) {
        $user['discs'] = int_field($f['discs'], 1, 999);
    }
    if (array_key_exists('use_photo', $f)) {
        $user['use_photo'] = !empty($f['use_photo']) ? 1 : 0;
    }

    // 3. Cover photo.
    $photo = $existing['cover_photo'] ?? null;
    if (!empty($in['photo']) && is_string($in['photo'])) {
        $newPhoto = save_photo($in['photo']);
        delete_photo($photo);
        $photo = $newPhoto;
    } elseif (!empty($in['remove_photo'])) {
        delete_photo($photo);
        $photo = null;
    }
    if (!$photo) {
        $user['use_photo'] = 0;
    }

    // 4. Write.
    $row = array_merge(
        $existing ? array_intersect_key($existing, array_flip(META_COLUMNS)) : [],
        $meta ?? [],
        $user,
        ['cover_photo' => $photo, 'updated_at' => now_iso()]
    );
    $pdo = db();
    if ($existing) {
        $sets = implode(', ', array_map(function ($k) {
            return "$k = :$k";
        }, array_keys($row)));
        $st = $pdo->prepare("UPDATE items SET $sets WHERE id = :id");
        $st->execute($row + ['id' => $id]);
    } else {
        $row['added_at'] = now_iso();
        $cols = array_keys($row);
        $st = $pdo->prepare('INSERT INTO items (' . implode(', ', $cols) . ') VALUES (:' . implode(', :', $cols) . ')');
        $st->execute($row);
        $id = (int)$pdo->lastInsertId();
    }
    learn_barcode($row['barcode'], (string)$row['title']);
    respond(['item' => shape_item(get_item($id))]);
}

function action_export(): void
{
    $rows = db()->query('SELECT * FROM items ORDER BY title COLLATE NOCASE, year')->fetchAll();
    $cols = ['title', 'year', 'media_type', 'season', 'format', 'location', 'discs', 'loaned_to', 'barcode', 'genres',
        'directors', 'cast_list', 'runtime', 'certification', 'rating', 'collection', 'imdb_id', 'tmdb_id', 'notes', 'added_at'];
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="dvd-library-' . date('Y-m-d') . '.csv"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");               // BOM so Excel reads the accents correctly
    fputcsv($out, $cols);
    foreach ($rows as $r) {
        $line = [];
        foreach ($cols as $c) {
            $v = (string)($r[$c] ?? '');
            // Keep spreadsheet apps from treating text as a formula.
            $line[] = ($v !== '' && strpos('=+-@', $v[0]) !== false && !is_numeric($v)) ? "'" . $v : $v;
        }
        fputcsv($out, $line);
    }
    fclose($out);
    exit;
}

// ───────────────────────────── routing ─────────────────────────────

$action = (string)($_GET['action'] ?? '');
$method = (string)($_SERVER['REQUEST_METHOD'] ?? 'GET');

if ($action === 'status') {
    $problems = [];
    if ($CFG === null) {
        $problems[] = 'config.php is missing. Copy config.sample.php to config.php and fill it in.';
    } elseif (trim((string)cfg('app_password')) === '') {
        $problems[] = 'Set app_password in config.php.';
    }
    if (!extension_loaded('pdo_sqlite')) {
        $problems[] = 'The server is missing the pdo_sqlite PHP extension (enable it in cPanel → Select PHP Version → Extensions).';
    }
    if (!extension_loaded('mbstring')) {
        $problems[] = 'The server is missing the mbstring PHP extension (enable it in cPanel → Select PHP Version → Extensions).';
    }
    if (!function_exists('curl_init') && !ini_get('allow_url_fopen')) {
        $problems[] = 'The server can\'t make outgoing requests (enable the curl extension).';
    }
    if ($problems) {
        respond(['configured' => false, 'problems' => $problems, 'version' => APP_VERSION]);
    }
    respond([
        'configured' => true,
        'authed'     => is_authed(),
        'tmdb'       => tmdb_enabled(),
        'barcode'    => (bool)cfg('upcitemdb_enabled'),
        'covers_url' => covers_url(),
        'version'    => APP_VERSION,
    ]);
}

if ($CFG === null || trim((string)cfg('app_password')) === '') {
    fail('The app is not set up yet (config.php).', 503);
}

// Writes must be POST and carry the app's header, which a third-party web page can't add.
$writes = ['login', 'logout', 'save', 'delete', 'refresh'];
if (in_array($action, $writes, true)) {
    if ($method !== 'POST' || ($_SERVER['HTTP_X_DVDLIB'] ?? '') !== '1') {
        fail('Bad request.', 400);
    }
}

if ($action === 'login') {
    $pw = (string)(body()['password'] ?? '');
    if (!hash_equals((string)cfg('app_password'), $pw)) {
        usleep(800000);   // slow down guessing
        fail('Wrong password.', 401);
    }
    set_auth_cookie(true);
    respond(['authed' => true]);
}

if ($action === 'logout') {
    set_auth_cookie(false);
    respond(['authed' => false]);
}

if (!is_authed()) {
    fail('Please sign in.', 401, ['signin' => true]);
}

switch ($action) {
    case 'list':
        $rows = db()->query('SELECT * FROM items ORDER BY title COLLATE NOCASE, year')->fetchAll();
        respond(['items' => array_map('shape_item', $rows)]);
        break;

    case 'search':
        $type = in_array($_GET['type'] ?? '', ['movie', 'tv'], true) ? $_GET['type'] : 'multi';
        $year = int_field($_GET['year'] ?? null, 1880, 2100);
        $q = trim((string)($_GET['q'] ?? ''));
        if ($q === '') {
            fail('Type a title to search for.', 400);
        }
        respond(['results' => with_owned(smart_search($q, $year, $type))]);
        break;

    case 'barcode':
        $code = digits_only((string)($_GET['code'] ?? ''));
        if (strlen($code) < 6 || strlen($code) > 14) {
            fail('That barcode doesn\'t look right.', 400);
        }
        // Already on the shelf?
        $variants = barcode_variants($code);
        $in = implode(',', array_fill(0, count($variants), '?'));
        $st = db()->prepare("SELECT * FROM items WHERE barcode IN ($in)");
        $st->execute($variants);
        $inLibrary = array_map('shape_item', $st->fetchAll());

        $product = product_title_for($code);
        $guess = null;
        $results = [];
        if ($product['status'] === 'found' && $product['title']) {
            $guess = clean_product_title((string)$product['title']);
            if (tmdb_enabled()) {
                $results = with_owned(smart_search($guess['title'], $guess['year'], $guess['season'] ? 'tv' : 'multi'));
            }
        }
        respond([
            'code'       => $code,
            'checksum'   => barcode_checksum_ok($code),
            'in_library' => $inLibrary,
            'product'    => $product,
            'guess'      => $guess,
            'results'    => $results,
        ]);
        break;

    case 'save':
        action_save();
        break;

    case 'delete':
        $item = get_item((int)(body()['id'] ?? 0));
        db()->prepare('DELETE FROM items WHERE id = ?')->execute([(int)$item['id']]);
        delete_photo($item['cover_photo']);
        respond(['deleted' => (int)$item['id']]);
        break;

    case 'refresh':
        $item = get_item((int)(body()['id'] ?? 0));
        if (!$item['tmdb_id']) {
            fail('This disc was added by hand, so there is nothing to refresh from TMDB.', 400);
        }
        $meta = tmdb_details((string)$item['media_type'], (int)$item['tmdb_id']);
        $meta['updated_at'] = now_iso();
        $sets = implode(', ', array_map(function ($k) {
            return "$k = :$k";
        }, array_keys($meta)));
        db()->prepare("UPDATE items SET $sets WHERE id = :id")->execute($meta + ['id' => (int)$item['id']]);
        respond(['item' => shape_item(get_item((int)$item['id']))]);
        break;

    case 'export':
        action_export();
        break;

    default:
        fail('Unknown action.', 404);
}
