# CoffeeRoute ☕

Vind koffiestops langs jouw fietsroute. Upload een `.fit` of `.gpx` bestand en ontdek cafés en bakkerijen langs de weg — met naam, adres, openingstijden en website.

---

## Stap 1 — Supabase account aanmaken (gratis)

1. Ga naar [supabase.com](https://supabase.com) en klik **Start your project**
2. Log in met GitHub
3. Klik **New project**
4. Geef het project de naam `coffeeroute`
5. Kies een wachtwoord (sla dit op)
6. Kies regio **West EU (Ireland)**
7. Klik **Create new project** en wacht ~2 minuten

---

## Stap 2 — Database tabel aanmaken

1. Ga in Supabase naar **SQL Editor** (linkermenu)
2. Klik **New query**
3. Plak de volgende SQL en klik **Run**:

```sql
create table cafes (
  id bigint generated always as identity primary key,
  osm_id bigint unique,
  name text not null,
  type text not null,
  lat double precision not null,
  lon double precision not null,
  address text,
  city text,
  opening_hours text,
  phone text,
  website text,
  wheelchair text,
  outdoor_seating boolean default false,
  created_at timestamptz default now()
);

-- Snelle zoekindex op locatie
create index cafes_lat_lon_idx on cafes (lat, lon);

-- Iedereen mag lezen (geen login nodig)
alter table cafes enable row level security;
create policy "Publiek leesbaar" on cafes for select using (true);
```

---

## Stap 3 — API sleutels ophalen

1. Ga in Supabase naar **Settings → API**
2. Kopieer de **Project URL** (ziet eruit als `https://abcdef.supabase.co`)
3. Kopieer de **anon public** key

Maak een `.env` bestand in de projectmap (kopieer `.env.example`):

```bash
cp .env.example .env
```

Open `.env` en vul in:
```
VITE_SUPABASE_URL=https://JOUW-PROJECT-ID.supabase.co
VITE_SUPABASE_ANON_KEY=JOUW-ANON-KEY
```

---

## Stap 4 — Café data importeren

Installeer de dependencies en draai het import script:

```bash
npm install
npm run import-osm
```

Dit haalt alle cafés en bakkerijen in Nederland op uit OpenStreetMap (~15.000 locaties) en importeert ze in je database. Duurt ongeveer 2-3 minuten.

---

## Stap 5 — Lokaal testen

```bash
npm run dev
```

Open [http://localhost:5173/coffeeroute/](http://localhost:5173/coffeeroute/) en upload een route!

---

## Stap 6 — Op GitHub zetten

```bash
git init
git add .
git commit -m "eerste versie"
git remote add origin https://github.com/JOUWNAAM/coffeeroute.git
git push -u origin main
```

---

## Stap 7 — GitHub Pages aanzetten

1. Ga naar je repository op GitHub
2. Klik **Settings → Pages**
3. Kies bij Source: **GitHub Actions**
4. Ga naar **Settings → Secrets and variables → Actions**
5. Voeg toe:
   - `VITE_SUPABASE_URL` → jouw Supabase URL
   - `VITE_SUPABASE_ANON_KEY` → jouw anon key
6. Ga naar **Actions** en klik **Run workflow**

De app is daarna live op `https://JOUWNAAM.github.io/coffeeroute/` 🎉

---

## Veelgestelde vragen

**Hoeveel kost dit?**
Supabase gratis tier: tot 500MB database en 2GB bandbreedte per maand. Voor persoonlijk gebruik meer dan genoeg.

**Hoe update ik de café data?**
Draai `npm run import-osm` opnieuw. Bestaande data wordt bijgewerkt, nieuwe locaties worden toegevoegd.

**Werkt dit ook voor andere landen?**
Ja! Pas de zoekopdracht in `scripts/import-osm.js` aan naar een ander land.
