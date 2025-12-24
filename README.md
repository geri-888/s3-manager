# S3 Storage Reseller Platform

Modern S3 tárhely viszonteladó platform PayPal fizetéssel.

## Funkciók

- **Felhasználói regisztráció/bejelentkezés** - Email és jelszó alapú
- **Tárhely vásárlás** - Csúszkával választható, 5 Ft/GB
- **PayPal fizetés** - Valódi PayPal integráció
- **Fájlkezelő** - Web alapú feltöltés/letöltés/törlés
- **S3 API proxy** - Saját access key és secret key minden felhasználónak
- **Tárhely limit** - Valós S3 méret követés, limit túllépés esetén csak törlés
- **Admin panel** - Felhasználók kezelése, felfüggesztés, törlés, statisztikák

## Telepítés

1. **Node.js telepítése** (ha nincs): https://nodejs.org/

2. **Függőségek telepítése**:
```bash
cd s3-reseller
npm install
```

3. **Környezeti változók beállítása**:
Szerkeszd a `.env` fájlt a saját adataiddal.

4. **Adatbázis inicializálása**:
```bash
npm run init-db
```

5. **Szerver indítása**:
```bash
npm run dev
```

6. **Megnyitás böngészőben**: http://localhost:3000

## Környezeti változók (.env)

```
# S3 - Központi hozzáférés (SOHA nem kerül ki a felhasználókhoz)
S3_ACCESS_KEY=your_s3_access_key
S3_SECRET_KEY=your_s3_secret_key
S3_ENDPOINT=https://your-s3-endpoint.com
S3_BUCKET=your-bucket-name

# Szerver
PORT=3000
SESSION_SECRET=valami-titkos-kulcs

# PayPal IPN (csak email kell, personal account)
PAYPAL_EMAIL=web@geri-888.hu

# Árazás
PRICE_PER_GB_HUF=5

# Admin
ADMIN_EMAIL=egyeb@geri-888.hu
ADMIN_PASSWORD=asd
```

## Admin belépés

- **Email**: egyeb@geri-888.hu
- **Jelszó**: asd

## S3 API használata (felhasználóknak)

Minden felhasználó kap:
- **Endpoint**: `http://yourserver.com/s3`
- **Access Key**: Egyedi generált kulcs
- **Secret Key**: Egyedi generált titkos kulcs

### API végpontok

**Fájlok listázása**:
```bash
curl -X GET "http://localhost:3000/s3/list" \
  -H "X-Access-Key: YOUR_ACCESS_KEY" \
  -H "X-Secret-Key: YOUR_SECRET_KEY"
```

**Fájl feltöltése**:
```bash
curl -X POST "http://localhost:3000/s3/upload" \
  -H "X-Access-Key: YOUR_ACCESS_KEY" \
  -H "X-Secret-Key: YOUR_SECRET_KEY" \
  -F "file=@yourfile.txt" \
  -F "path=folder/yourfile.txt"
```

**Fájl letöltése**:
```bash
curl -X GET "http://localhost:3000/s3/download?path=yourfile.txt" \
  -H "X-Access-Key: YOUR_ACCESS_KEY" \
  -H "X-Secret-Key: YOUR_SECRET_KEY"
```

**Fájl törlése**:
```bash
curl -X DELETE "http://localhost:3000/s3/delete?path=yourfile.txt" \
  -H "X-Access-Key: YOUR_ACCESS_KEY" \
  -H "X-Secret-Key: YOUR_SECRET_KEY"
```

## Biztonság

- A központi S3 kulcsok SOHA nem kerülnek ki a felhasználókhoz
- Minden felhasználó csak a saját mappájához fér hozzá
- A mappa neve egy UUID, amit a felhasználó nem lát
- Felfüggesztett felhasználók semmilyen műveletet nem végezhetnek
- Törléskor minden fájl és hozzáférés törlődik

## Technológiák

- **Backend**: Node.js, Express
- **Frontend**: Vanilla JS, TailwindCSS
- **Adatbázis**: SQLite (better-sqlite3)
- **S3**: AWS SDK v3 (kompatibilis bármely S3-kompatibilis szolgáltatással)
- **Fizetés**: PayPal IPN
