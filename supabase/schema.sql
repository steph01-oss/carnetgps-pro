-- CarnetGPS Pro : schéma Supabase. À coller tel quel dans SQL Editor > Run. Relançable sans risque.
create extension if not exists pgcrypto;

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text not null unique,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

alter table public.teams add column if not exists code_expires_at timestamptz not null default (now() + interval '7 days');

create table if not exists public.members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null,
  display_name text not null,
  color text,
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
alter table public.members add column if not exists role text not null default 'member';
do $$ begin
  alter table public.members add constraint members_role_chk check (role in ('admin','member'));
exception when duplicate_object then null; end $$;
create index if not exists members_user_idx on public.members(user_id);

-- Journal des codes erronés (anti force brute). Aucune politique RLS : inaccessible hors fonctions security definer.
create table if not exists public.join_attempts (
  user_id uuid not null, at timestamptz not null default now()
);
create index if not exists join_attempts_idx on public.join_attempts(user_id, at);
alter table public.join_attempts enable row level security;

-- Limites de taille (évite l'abus de stockage)
do $$ begin
  alter table public.clients add constraint clients_size_chk check (
    length(coalesce(name,'')) <= 200 and length(coalesce(address,'')) <= 400 and length(coalesce(phone,'')) <= 40 and length(coalesce(notes,'')) <= 2000);
exception when duplicate_object then null; end $$;

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
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.updated < old.updated then
      return null;              -- écriture plus ancienne : ignorée silencieusement
    end if;
    new.team_id := old.team_id; -- on ne déplace pas un client d'équipe
    new.owner_id := old.owner_id; new.owner_name := old.owner_name; new.owner_color := old.owner_color; -- propriétaire non falsifiable
  else
    if (select count(*) from public.clients where team_id = new.team_id) >= 5000 then
      raise exception 'EQUIPE_CLIENTS_MAX';
    end if;
    if auth.uid() is not null then new.owner_id := auth.uid(); end if;
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

create or replace function public.is_admin(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where team_id = p_team and user_id = auth.uid() and role = 'admin');
$$;

create or replace function public.create_team(p_name text, p_display_name text, p_color text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.teams;
begin
  if auth.uid() is null then raise exception 'NON_CONNECTE'; end if;
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_display_name), '') = '' then
    raise exception 'NOM_REQUIS';
  end if;
  insert into public.teams(name, join_code, created_by)
    values (left(trim(p_name),80), public.gen_join_code(), auth.uid()) returning * into t;
  insert into public.members(team_id, user_id, display_name, color, role)
    values (t.id, auth.uid(), left(trim(p_display_name),40), left(coalesce(p_color,''),9), 'admin');
  return jsonb_build_object('team_id', t.id, 'team_name', t.name, 'join_code', t.join_code, 'code_expires_at', t.code_expires_at, 'role', 'admin');
end $$;

-- Rejoindre : 5 codes faux en 15 min => blocage temporaire. Les erreurs "métier" sont RETOURNÉES (pas levées)
-- sinon l'annulation de la transaction effacerait le journal des tentatives.
create or replace function public.join_team(p_code text, p_display_name text, p_color text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.teams; m public.members;
begin
  if auth.uid() is null then raise exception 'NON_CONNECTE'; end if;
  if (select count(*) from public.join_attempts where user_id = auth.uid() and at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('error', 'TROP_DESSAIS');
  end if;
  select * into t from public.teams where join_code = upper(trim(coalesce(p_code, '')));
  if not found then
    insert into public.join_attempts(user_id) values (auth.uid());
    return jsonb_build_object('error', 'CODE_INVALIDE');
  end if;
  select * into m from public.members where team_id = t.id and user_id = auth.uid();
  if not found then
    if now() > t.code_expires_at then return jsonb_build_object('error', 'CODE_EXPIRE'); end if;
    if (select count(*) from public.members where team_id = t.id) >= 10 then raise exception 'EQUIPE_PLEINE'; end if;
  end if;
  insert into public.members(team_id, user_id, display_name, color)
    values (t.id, auth.uid(), left(trim(coalesce(p_display_name,'')),40), left(coalesce(p_color,''),9))
    on conflict (team_id, user_id) do update set display_name = excluded.display_name, color = excluded.color
    returning * into m;
  return jsonb_build_object('team_id', t.id, 'team_name', t.name, 'role', m.role,
    'join_code', case when m.role = 'admin' then t.join_code else null end,
    'code_expires_at', case when m.role = 'admin' then t.code_expires_at else null end);
end $$;

-- Patron : nouveau code (l'ancien devient invalide), valable 7 jours.
create or replace function public.regenerate_code(p_team uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.teams;
begin
  if not public.is_admin(p_team) then raise exception 'NON_ADMIN'; end if;
  update public.teams set join_code = public.gen_join_code(), code_expires_at = now() + interval '7 days'
    where id = p_team returning * into t;
  return jsonb_build_object('join_code', t.join_code, 'code_expires_at', t.code_expires_at);
end $$;

-- Patron : retirer un livreur (il perd l'accès immédiatement).
create or replace function public.remove_member(p_team uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(p_team) then raise exception 'NON_ADMIN'; end if;
  if p_user = auth.uid() then raise exception 'NON_ADMIN'; end if;
  delete from public.members where team_id = p_team and user_id = p_user;
end $$;

-- Quitter l'équipe (droit à l'effacement) : si le patron part, le plus ancien membre devient patron ; le dernier ferme l'équipe.
create or replace function public.leave_team(p_team uuid)
returns void language plpgsql security definer set search_path = public as $$
declare was_admin boolean; nxt uuid;
begin
  select role = 'admin' into was_admin from public.members where team_id = p_team and user_id = auth.uid();
  if was_admin is null then return; end if;
  delete from public.members where team_id = p_team and user_id = auth.uid();
  if not exists (select 1 from public.members where team_id = p_team) then
    delete from public.teams where id = p_team;
  elsif was_admin and not exists (select 1 from public.members where team_id = p_team and role = 'admin') then
    select user_id into nxt from public.members where team_id = p_team order by joined_at limit 1;
    update public.members set role = 'admin' where team_id = p_team and user_id = nxt;
  end if;
end $$;

-- Patron : supprimer l'équipe et TOUTES ses données (clients, membres).
create or replace function public.delete_team(p_team uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(p_team) then raise exception 'NON_ADMIN'; end if;
  delete from public.teams where id = p_team;
end $$;

revoke all on function public.create_team(text,text,text), public.join_team(text,text,text),
  public.regenerate_code(uuid), public.remove_member(uuid,uuid), public.leave_team(uuid), public.delete_team(uuid), public.is_admin(uuid) from public, anon;
grant execute on function public.create_team(text,text,text), public.join_team(text,text,text),
  public.regenerate_code(uuid), public.remove_member(uuid,uuid), public.leave_team(uuid), public.delete_team(uuid), public.is_admin(uuid) to authenticated;
grant execute on function public.is_member(uuid) to authenticated;

-- Le code d'équipe n'est lisible que par le patron (les autres membres ne peuvent pas le lire via l'API).
revoke select on public.teams from authenticated;
grant select (id, name, created_at) on public.teams to authenticated;
create or replace function public.team_code(p_team uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.teams;
begin
  if not public.is_admin(p_team) then raise exception 'NON_ADMIN'; end if;
  select * into t from public.teams where id = p_team;
  return jsonb_build_object('join_code', t.join_code, 'code_expires_at', t.code_expires_at);
end $$;
revoke all on function public.team_code(uuid) from public, anon;
grant execute on function public.team_code(uuid) to authenticated;

-- Pull incrémental (exécuté par cloud.js via PostgREST) :
--   GET /rest/v1/clients?team_id=eq.<team>&server_updated=gt.<serverTime précédent>&order=server_updated.asc&limit=1000
-- équivalent SQL : select * from clients where team_id = :team and server_updated > :since order by server_updated;
-- On filtre sur server_updated (horloge serveur), jamais sur updated (horloge du téléphone).
