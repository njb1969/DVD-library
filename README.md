# DVD Library

A self-hosted catalogue of the discs on your shelves, built for a tablet in the lounge room.

- **Add discs three ways:** scan the barcode, photograph the front cover (the title is read off the picture), or type the title.
- **Details filled in for you** from TMDB (The Movie Database): poster, year, running time, Australian classification, director, cast, genres, plot, collection, and a link to the IMDb page.
- **Find anything fast:** one search box covers title, actor, director, genre, shelf, notes and who's borrowed it. Filter by shelf, film/TV, format or "on loan"; sort by title, recently added, year or shelf.
- **Your copy, your notes:** shelf, format (DVD / Blu-ray / 4K UHD), season, number of discs, barcode, notes, your own cover photo, and a lending record.
- **Shelf mode:** set the shelf once, tick *Keep adding*, and scan disc after disc.

Runs on ordinary cPanel hosting: PHP + a single SQLite file. No database to create, nothing to install.

---

## 1. Get a TMDB key (free, about 5 minutes)

1. Create an account at <https://www.themoviedb.org/signup> and confirm the email.
2. Go to **Settings → API** (<https://www.themoviedb.org/settings/api>) and request a **Developer** key. It's free for personal, non-commercial use. Describe it as a personal home DVD catalogue.
3. Copy the **API Read Access Token** (the long one starting `eyJ…`). The shorter *API Key* also works.

## 2. Make a subdomain with HTTPS

The tablet's camera only works on an `https://` address.

1. cPanel → **Domains → Create A New Domain**, e.g. `dvd.yourdomain.com`. Note the folder cPanel creates for it.
2. cPanel → **SSL/TLS Status**: tick the new subdomain → **Run AutoSSL**. Wait for a valid certificate.
3. cPanel → **Domains**: switch on **Force HTTPS Redirect** for the subdomain.

## 3. Upload and configure

1. cPanel → **File Manager**, open the subdomain's folder, upload `dvd-library-1.0.0.zip`, then **Extract** it there. (The zip has no top folder — files land directly in the subdomain's folder.)
2. In that folder, **Copy** `config.sample.php` to `config.php`, then **Edit** `config.php`:
   - `tmdb_key` → paste the token from step 1
   - `app_password` → the password the tablet will use
3. cPanel → **Select PHP Version**: choose PHP 8.x (7.4 also works) and make sure these extensions are ticked: `pdo_sqlite`, `curl`, `mbstring`, `gd`. They usually are already.
4. Open `https://dvd.yourdomain/` in a browser. If anything is missing, the page lists exactly what to fix. Otherwise you'll see the sign-in box.

The `data/` folder (database) is blocked from the web by its own `.htaccess`, and `config.php` is never shown as text, so your key and password stay private.

## 4. Set up the tablet

1. Open the address in **Chrome** and sign in. The tablet stays signed in for about a year.
2. Tap **Add discs** and allow the camera when asked.
3. Chrome menu **⋮ → Add to Home screen** gives it a full-screen icon like an app.

**If you use Fully Kiosk Browser:** turn on **Settings → Web Content Settings → Enable Webcam Access**, otherwise the camera stays blank. If *Choose photo* doesn't open the gallery, enable file uploads in the same section.

---

## Using it

### Scanning barcodes
Hold the back of the case so the barcode sits inside the gold frame; it beeps when read. Then pick the right match from the list and tap **Add to library**. In dim light, the 💡 button turns the torch on (on tablets that allow it).

The barcode-to-title step uses UPCitemdb's free lookup, which allows **about 100 lookups a day** and doesn't know every Australian release. When a barcode isn't recognised you'll see a message and can photograph the cover or type the title instead. **The barcode is still saved with the disc**, so if you ever scan it again it's found instantly from your own library, with no outside lookup.

### Photographing covers
Fill the gold frame with the front cover and tap **Take photo**. The words found on the cover appear as buttons, biggest lettering first (usually the title), and a search runs straight away. Tap words on or off to adjust the search. The first cover photo of a session downloads the text reader (a few MB), so allow a few seconds. Your photo is kept with the disc unless you untick *Keep my photo of this cover*.

### Typing a title
Type a few words, optionally a year, and choose *Film* or *TV series* to narrow it down.

### Not on TMDB?
Home videos, concerts, fitness DVDs, compilations: use **Not listed? Add it by hand**.

### On the catalogue card
Tap any disc to open its card: **Edit details**, **Lend** / **Mark returned**, **Change match** (if the wrong film was picked; your shelf, notes and loan are kept), **Refresh details** (re-download from TMDB) and **Delete**.

---

## Backups and updates

- **Download list (CSV)** in the ⋯ menu gives a spreadsheet of everything.
- The complete library is `data/library.sqlite` plus your photos in `covers/`. Download those two through File Manager for a full backup.
- **Updating to a newer version:** upload the new files over the old ones, but **don't overwrite `config.php`, `data/` or `covers/`**.
- Changing `app_password` in `config.php` signs out every device.

## Files

| File | What it does |
|---|---|
| `index.html`, `app.js`, `styles.css` | The tablet app |
| `api.php` | Server side: sign-in, the library database, TMDB and barcode lookups |
| `config.sample.php` | Settings template, copied to `config.php` |
| `data/` | The SQLite database and sign-in secret (web access blocked) |
| `covers/` | Your own cover photos |
| `manifest.webmanifest`, `icon-*.png` | Home-screen icon |

## Credits

Film and TV information and posters come from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. Barcode titles come from UPCitemdb. Barcode reading in browsers without a built-in reader uses ZXing; cover text reading uses Tesseract.js.

IMDb doesn't offer a free public API, so the app links to each title's IMDb page using the IMDb ID that TMDB provides.
