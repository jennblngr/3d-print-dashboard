# 3D Print Dashboard

A small installable web app (PWA) for one maker and their private circle.

- **Owner (password):** filament spool inventory with barcode / RFID scanning, prints billed per gram of filament, payments, and the wishlist of everyone.
- **Guests (private invite link, no account):** what they owe and why, their payment history, and a wishlist to ask for prints.

No dependencies: Node 24+ and its built-in SQLite. Data lives in one file, `data/app.db`.

## Run locally

```sh
npm run set-password   # asks for the owner password, stores only its hash in .env
npm start              # http://localhost:3000
```

## Deploy on a VPS

The VPS already runs nginx for other sites, so the app ships no reverse proxy of its own: its container listens on
`127.0.0.1:3020` only, and the host's nginx forwards `3d-print-dashboard.jennblngr.com` to it over HTTPS (certbot).
HTTPS is required by the camera, NFC and "install app" features.

```sh
# 1. code
sudo git clone https://github.com/jennblngr/3d-print-dashboard.git /var/www/3d-print-dashboard
cd /var/www/3d-print-dashboard

# 2. owner password: asks for it and writes only its hash to .env
sudo docker run --rm -it -v "$PWD":/app -w /app node:24-alpine node scripts/set-password.js

# 3. app
sudo docker compose up -d --build

# 4. nginx + HTTPS
sudo cp nginx/3d-print-dashboard.conf /etc/nginx/sites-available/3d-print-dashboard.jennblngr.com
sudo ln -s /etc/nginx/sites-available/3d-print-dashboard.jennblngr.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d 3d-print-dashboard.jennblngr.com
```

To update later: `sudo git pull && sudo docker compose up -d --build` (a backup is taken at each start).

## Backups

The app backs its database up by itself, into the `backups` folder of the data directory: at every start (before any
upgrade of the data) and then once a day. Each backup is checked for integrity. The first and last backup of each of
the last 14 days are kept. The owner's screen shows the date of the last one.

These backups live on the same machine as the data. To survive the loss of the server, copy them elsewhere regularly:

```sh
sudo docker compose cp app:/data/backups ./backups
```

To restore:

```sh
# locally: stop the app, then
npm run restore                 # lists the backups
npm run restore -- <name>       # puts one back; the replaced database is kept as before-restore-<date>.db

# on the VPS
sudo docker compose stop app
sudo docker compose run --rm app node scripts/restore-backup.js <name>
sudo docker compose start app
```

## Security

- The owner password is never stored: `.env` holds a salted scrypt hash, and 10 wrong attempts lock an address out for 15 minutes.
- Every address is limited to 300 requests per minute, of which 60 changes.
- Guests have no password. Their invite link is the key to their own data only, and the owner can replace it.

## Android NFC companion

`android/` holds a tiny Android app with no screen, for the owner's phone only. Holding a TigerTag chip against the
phone starts it: it reads the chip memory (read-only, nothing is ever written to a chip) and opens the dashboard at
`#tigertag=<bytes>`, which opens the matching spool or prefills a new one. Its icon simply opens the dashboard.

```sh
sh android/build.sh                                         # needs a JDK and the Android SDK, no Gradle
adb install -r android/build/3d-print-dashboard-nfc.apk     # phone plugged in, USB debugging allowed
```

The build is signed with the standard Android debug key (`~/.android/debug.keystore`, created if missing and never
committed). The dashboard address is set in `android/res/values/strings.xml`.

## How billing works

A print line costs `grams × spool price ÷ spool net weight`, rounded to the cent and frozen when the print is recorded.
An optional adjustment (extras or a discount) is added on top. A person's balance is their prints minus their payments.
Recording a print takes the grams off the spool; deleting the print gives them back.

## Scanning

- **Barcode:** uses the browser's `BarcodeDetector` (Chrome on Android). A barcode names a product, so several
  spools can share it. The app remembers what you saved for a barcode (brand, material, colour, weight, price) and
  prefills the next spool of that product; scanning also lists the spools you already own with that barcode.
  Nothing is looked up online.
- **TigerTag chips:** they are not in the NDEF format, so no browser can read them. The app can decode their memory
  (`public/tigertag.js`, following the open [TigerTag specification](https://github.com/TigerTag-Project/TigerTag-RFID-Guide))
  when it is opened with the chip's bytes as hexadecimal text, from page 0, after `#tigertag=` in the URL. It then
  prefills brand, material, type, colour and weight, and identifies the spool by the chip's serial number. Reading
  the chip and opening that URL is the job of the Android companion app in `android/` (see below).
  Brand and material names come from the public TigerTag registry (CC0), bundled in `public/tigertag-db.js`;
  refresh it with `node scripts/make-tigertag-db.js <registry database folder>`.
