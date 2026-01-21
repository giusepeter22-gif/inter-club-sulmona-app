# Setup Supabase + Netlify (versione automatica)

Questa versione elimina `data.json` come pubblicazione manuale: **eventi/quiz/bacheca/punti/prenotazioni** si aggiornano per tutti i soci tramite **Supabase** (DB) + **Netlify Functions** (server).

## 1) Supabase: crea tabella `app_data`

Nel pannello Supabase → SQL Editor → esegui:

```sql
create table if not exists public.app_data (
  key text primary key,
  payload jsonb not null
);
```

Poi inserisci un record iniziale (anche vuoto):

```sql
insert into public.app_data (key, payload)
values ('main', '{}'::jsonb)
on conflict (key) do update set payload = excluded.payload;
```

## 2) Netlify: variabili d’ambiente (Site settings → Environment variables)

Imposta queste 3 variabili:

- `SUPABASE_URL` = URL del progetto Supabase (es. https://xxxx.supabase.co)
- `SUPABASE_SERVICE_ROLE_KEY` = service_role key (Supabase → Project settings → API)
- `ADMIN_PIN` = 190894

> NB: la **SERVICE_ROLE_KEY** resta solo su Netlify (server), NON è nel codice dell’app.

## 3) Deploy
Carica la cartella su Netlify come hai sempre fatto.

Da questo momento:
- quando salvi dall’admin → si aggiorna subito per tutti
- quando un socio prenota/risponde al quiz → aggiorna per tutti (posti rimasti, punti, ecc.)

## Note
- Se Netlify ti chiede build: non serve. È una static app + functions.
- Se vuoi cambiare PIN: aggiorna `ADMIN_PIN` su Netlify.