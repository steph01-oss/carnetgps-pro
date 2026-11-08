-- CarnetGPS Pro : schéma Supabase. À coller tel quel dans SQL Editor > Run. Relançable sans risque.
create extension if not exists pgcrypto;

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text not null unique,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null,
  display_name text not null,
  color text,
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index if not exists members_user_idx on public.members(user_id);

create table if not exists public.clients (
  id uuid primary key,
  team_id uuid not null references public.teams(id) on delete cascade,
  name text, address text, phone text, notes text,
  lat double precision, lng double precision,
  reported boolean not null default false,
  deleted boolean not null default false,
  updated timestamptz not null default now(),
  owner_id uuid, owner_name text, owner_color text,
  server_updated timestamptz not null default now()
);
create index if not exists clients_team_sync_idx on public.clients(team_id, server_updated);

-- Trigger : horodatage serveur (sert au pull incrémental) + dernier "updated" gagne.
create or replace function public.clients_before_write() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated < old.updated then
      return null;              -- écriture plus ancienne : ignorée silencieusement
    end if;
    new.team_id := old.team_id; -- on ne déplace pas un client d'équipe
  end if;
  new.server_updated := clock_timestamp();
  return new;
end $$;
drop trigger if exists clients_before_write on public.clients;
create trigger clients_before_write before insert or update on public.clients
  for each row execute function public.clients_before_write();

-- Appartenance (security definer : évite la récursion RLS)
create or replace function public.is_member(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where team_id = p_team and user_id = auth.uid());
$$;

alter table public.teams enable row level security;
alter table public.members enable row level security;
alter table public.clients enable row level security;

drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams for select to authenticated using (public.is_member(id));

drop policy if exists members_select on public.members;
create policy members_select on public.members for select to authenticated using (public.is_member(team_id));
-- Aucune politique insert/update/delete sur teams et members : uniquement via create_team / join_team.

drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients for select to authenticated using (public.is_member(team_id));
drop policy if exists clients_insert on public.clients;
create policy clients_insert on public.clients for insert to authenticated with check (public.is_member(team_id));
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients for update to authenticated
  using (public.is_member(team_id)) with check (public.is_member(team_id));
-- Pas de DELETE : la suppression est logique (deleted = true).

-- Code lisible de 6 caractères, sans O/0/I/1
create or replace function public.gen_join_code() returns text
language plpgsql as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text; i int;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.teams where join_code = code);
  end loop;
  return code;
end $$;

create or replace function public.create_team(p_name text, p_display_name text, p_color text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.teams;
begin
  if auth.uid() is null then raise exception 'NON_CONNECTE'; end if;
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_display_name), '') = '' then
    raise exception 'NOM_REQUIS';
  end if;
  insert into public.teams(name, join_code, created_by)
    values (trim(p_name), public.gen_join_code(), auth.uid()) returning * into t;
  insert into public.members(team_id, user_id, display_name, color)
    values (t.id, auth.uid(), trim(p_display_name), p_color);
  return jsonb_build_object('team_id', t.id, 'team_name', t.name, 'join_code', t.join_code);
end $$;

create or replace function public.join_team(p_code text, p_display_name text, p_color text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.teams;
begin
  if auth.uid() is null then raise exception 'NON_CONNECTE'; end if;
  select * into t from public.teams where join_code = upper(trim(coalesce(p_code, '')));
  if not found then raise exception 'CODE_INVALIDE'; end if;
  if not exists (select 1 from public.members where team_id = t.id and user_id = auth.uid()) then
    if (select count(*) from public.members where team_id = t.id) >= 10 then
      raise exception 'EQUIPE_PLEINE';
    end if;
  end if;
  insert into public.members(team_id, user_id, display_name, color)
    values (t.id, auth.uid(), trim(p_display_name), p_color)
    on conflict (team_id, user_id) do update set display_name = excluded.display_name, color = excluded.color;
  return jsonb_build_object('team_id', t.id, 'team_name', t.name, 'join_code', t.join_code);
end $$;

revoke all on function public.create_team(text,text,text), public.join_team(text,text,text) from public, anon;
grant execute on function public.create_team(text,text,text), public.join_team(text,text,text) to authenticated;
grant execute on function public.is_member(uuid) to authenticated;

-- Pull incrémental (exécuté par cloud.js via PostgREST) :
--   GET /rest/v1/clients?team_id=eq.<team>&server_updated=gt.<serverTime précédent>&order=server_updated.asc&limit=1000
-- équivalent SQL : select * from clients where team_id = :team and server_updated > :since order by server_updated;
-- On filtre sur server_updated (horloge serveur), jamais sur updated (horloge du téléphone).
