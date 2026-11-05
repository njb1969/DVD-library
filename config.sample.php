<?php
/*
 * DVD Library — configuration
 *
 * 1. Copy this file to config.php (same folder).
 * 2. Fill in tmdb_key and app_password.
 * 3. Upload. config.php is never served as text (PHP runs it), so the key stays private.
 *
 * When you upload a newer version of the app later, don't overwrite config.php.
 */
return [

    // TMDB credentials (free for personal use) — https://www.themoviedb.org/settings/api
    // Paste EITHER the "API Read Access Token" (long, starts with eyJ...) OR the shorter "API Key".
    'tmdb_key' => '',

    // Password the tablet uses to unlock the library. Required.
    // The tablet stays signed in for about a year; changing this signs every device out.
    'app_password' => '',

    // Free barcode lookups via UPCitemdb (no sign-up, about 100 lookups a day).
    // Set to false to skip barcode-to-title lookups entirely (scanning still records the barcode).
    'upcitemdb_enabled' => true,

    // Which country's classification to store (M, MA15+, PG...). Two-letter code.
    'certification_country' => 'AU',

    // Language for titles and plot summaries from TMDB.
    'language' => 'en-US',

    // Where the SQLite database lives. The default folder ships with an .htaccess that blocks web access.
    // For extra safety you can point this at a folder outside public_html, e.g. '/home/USERNAME/dvdlib-data'.
    'data_dir' => __DIR__ . '/data',

    // Where your own cover photos are saved. Must be inside the web folder so the tablet can show them.
    'covers_dir' => __DIR__ . '/covers',

];
