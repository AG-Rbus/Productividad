-- ════════════════════════════════════════════════════════════════
-- Gestor de Tareas — esquema de base de datos para Supabase
-- ════════════════════════════════════════════════════════════════
-- Cómo usarlo:
--  1. Entrá a tu proyecto en https://supabase.com/dashboard
--  2. Menú izquierdo → "SQL Editor" → "New query"
--  3. Pegá TODO este archivo y clic en "Run"
-- Con eso quedan creadas las tablas y la seguridad (RLS) que hace
-- que cada usuario vea únicamente sus propios datos.
-- ════════════════════════════════════════════════════════════════

-- Tareas
create table if not exists public.tasks (
  id            text not null,
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text,
  freq          text,
  due           text,
  notes         text,
  done          boolean default false,
  "totalMs"     bigint default 0,
  "createdAt"   text,
  "completedAt" text,
  "generatedFrom" text,
  primary key (user_id, id)
);

-- Eventualidades
create table if not exists public.events (
  id            text not null,
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text,
  prio          text,
  date          text,
  notes         text,
  done          boolean default false,
  "totalMs"     bigint default 0,
  "createdAt"   text,
  "completedAt" text,
  primary key (user_id, id)
);

-- Recordatorios
create table if not exists public.reminders (
  id      text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  text    text,
  date    text,
  time    text,
  done    boolean default false,
  primary key (user_id, id)
);

-- Historial de sesiones (log)
create table if not exists public.log (
  id      text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  "taskId" text,
  type    text,
  name    text,
  freq    text,
  ms      bigint default 0,
  date    text,
  primary key (user_id, id)
);

-- Configuración (una fila por usuario)
create table if not exists public.user_config (
  user_id uuid primary key references auth.users(id) on delete cascade,
  config  jsonb default '{}'::jsonb
);

-- Timer activo (una fila por usuario; null si no hay nada corriendo)
create table if not exists public.active_timer (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timer   jsonb
);

-- ── ROW LEVEL SECURITY: cada usuario solo ve/edita sus propias filas ──
alter table public.tasks         enable row level security;
alter table public.events        enable row level security;
alter table public.reminders     enable row level security;
alter table public.log           enable row level security;
alter table public.user_config   enable row level security;
alter table public.active_timer  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['tasks','events','reminders','log','user_config','active_timer']
  loop
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

-- ── REALTIME: habilita que los cambios se empujen en vivo a otros dispositivos ──
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.reminders;
alter publication supabase_realtime add table public.log;
alter publication supabase_realtime add table public.user_config;
alter publication supabase_realtime add table public.active_timer;
