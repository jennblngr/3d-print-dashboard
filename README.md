# 3D Print Dashboard

A small installable web app (PWA) for one maker and their private circle.

- **Owner (password):** filament spool inventory with barcode / RFID scanning, prints billed per gram of filament, payments, and the wishlist of everyone.
- **Guests (private invite link, no account):** what they owe and why, their payment history, and a wishlist to ask for prints.

No dependencies: Node 24+ and its built-in SQLite. Data lives in one file, `data/app.db`.

## Run locally

```sh
ADMIN_PASSWORD='a long passphrase' node server.js
# http://localhost:3000
```

## Deploy on a VPS

Point a domain's DNS record at the VPS, install Docker, then:

```sh
cp .env.example .env   # set ADMIN_PASSWORD and DOMAIN
docker compose up -d --build
```

Caddy serves the app over HTTPS, which the camera, NFC and "install app" features require.

Backup: copy the `app.db*` files out of the `data` volume, for example
`docker compose cp app:/data ./backup`.

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
