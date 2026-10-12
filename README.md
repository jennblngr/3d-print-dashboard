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

Point a domain's DNS record at the VPS, install Docker, then:

```sh
cp .env.example .env   # set DOMAIN
# add the ADMIN_PASSWORD_HASH line: copy it from the .env made by "npm run set-password" on your own machine
docker compose up -d --build
```

Caddy serves the app over HTTPS, which the camera, NFC and "install app" features require.

## Backups

The app backs its database up by itself, into the `backups` folder of the data directory: at every start (before any
upgrade of the data) and then once a day. Each backup is checked for integrity. The first and last backup of each of
the last 14 days are kept. The owner's screen shows the date of the last one.

These backups live on the same machine as the data. To survive the loss of the server, copy them elsewhere regularly:

```sh
docker compose cp app:/data/backups ./backups
```

To restore:

```sh
# locally: stop the app, then
npm run restore                 # lists the backups
npm run restore -- <name>       # puts one back; the replaced database is kept as before-restore-<date>.db

# on the VPS
docker compose stop app
docker compose run --rm app node scripts/restore-backup.js <name>
docker compose start app
```

## Security

- The owner password is never stored: `.env` holds a salted scrypt hash, and 10 wrong attempts lock an address out for 15 minutes.
- Every address is limited to 300 requests per minute, of which 60 changes.
- Guests have no password. Their invite link is the key to their own data only, and the owner can replace it.

## How billing works

A print line costs `grams × spool price ÷ spool net weight`, rounded to the cent and frozen when the print is recorded.
An optional adjustment (extras or a discount) is added on top. A person's balance is their prints minus their payments.
Recording a print takes the grams off the spool; deleting the print gives them back.

## Scanning

- **Barcode:** uses the browser's `BarcodeDetector` (Chrome on Android). A barcode names a product, so several
  spools can share it. The app remembers what you saved for a barcode (brand, material, colour, weight, price) and
  prefills the next spool of that product; scanning also lists the spools you already own with that barcode.
  Nothing is looked up online.
- **RFID (TigerTag and other NFC tags):** uses Web NFC (Chrome on Android only). The tag's serial number is unique
  to one spool, and scanning it opens that spool. Browsers cannot read the TigerTag data stored on the chip, so brand, material and colour are typed once.
