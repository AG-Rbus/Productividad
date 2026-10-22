-- ════════════════════════════════════════════════════════════════
-- Migración: sincronización por registro + tablero Kanban
-- ════════════════════════════════════════════════════════════════
-- Correr UNA vez en Supabase → SQL Editor → New query → Run.
-- Es segura de re-ejecutar (usa "if not exists").
--
-- 1) Columnas nuevas para el tablero (columna del kanban y orden).
--    Sin esto la app funciona igual, pero la columna/orden de cada
--    tarjeta queda guardada sólo en el dispositivo donde la moviste.
alter table public.tasks  add column if not exists status      text;
alter table public.tasks  add column if not exists "sortOrder" double precision;
alter table public.events add column if not exists status      text;
alter table public.events add column if not exists "sortOrder" double precision;

-- 2) La app ahora hace upsert/delete por fila (ya no usa save_full_state).
--    Las políticas de RLS de schema.sql (select/insert/update/delete own)
--    alcanzan; las recreamos por si alguna faltaba.
do $$
declare t text;
begin
  foreach t in array array['tasks','events','reminders','log','user_config','active_timer'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "select_own" on public.%I', t);
    execute format('drop policy if exists "insert_own" on public.%I', t);
    execute format('drop policy if exists "update_own" on public.%I', t);
    execute format('drop policy if exists "delete_own" on public.%I', t);
    execute format('create policy "select_own" on public.%I for select using (auth.uid() = user_id)', t);
    execute format('create policy "insert_own" on public.%I for insert with check (auth.uid() = user_id)', t);
    execute format('create policy "update_own" on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('create policy "delete_own" on public.%I for delete using (auth.uid() = user_id)', t);
  end loop;
end $$;

-- 3) Realtime: asegurar que todas las tablas estén publicadas
do $$
declare t text;
begin
  foreach t in array array['tasks','events','reminders','log','user_config','active_timer'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 4) Opcional: la función vieja ya no se usa. Podés borrarla cuando
--    todos los dispositivos tengan la versión nueva:
-- drop function if exists public.save_full_state;
