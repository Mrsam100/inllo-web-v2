-- ═══════════════════════════════════════════════════
--  INLLO — Supabase Database Schema
--  Supports 1M+ subscribers with efficient queries
-- ═══════════════════════════════════════════════════

-- 1. SUBSCRIBERS TABLE
create table if not exists public.subscribers (
  id          bigint generated always as identity primary key,
  name        text        not null check (char_length(name) between 1 and 100),
  email       text        not null
                          check (email ~* '^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$'),
  lang        text        not null check (lang in ('es', 'en')),
  newsletter  boolean     not null default true,
  status      text        not null default 'active' check (status in ('active', 'unsubscribed')),
  email_sent  boolean     not null default false,
  created_at  timestamptz not null default now()
);

-- Unique email (case-insensitive)
create unique index if not exists idx_subscribers_email
  on public.subscribers (lower(email));

-- Indexes for filtered + sorted queries (admin dashboard)
create index if not exists idx_subscribers_status_date
  on public.subscribers (status, created_at desc);

create index if not exists idx_subscribers_lang_date
  on public.subscribers (lang, created_at desc);

create index if not exists idx_subscribers_nl_status_date
  on public.subscribers (newsletter, status, created_at desc)
  where newsletter = true and status = 'active';

-- Full-text search index on name + email (used by search_subscribers)
create index if not exists idx_subscribers_search
  on public.subscribers using gin (
    to_tsvector('simple', name || ' ' || email)
  );

-- 2. CONFIG TABLE
create table if not exists public.config (
  key   text primary key,
  value text not null
);

-- Insert default PDF URLs (Spanish + English)
insert into public.config (key, value)
values ('pdf_url_es', 'https://drive.google.com/uc?export=download&id=1B7bO4wl2oqzxJ5Rpr1hny1L-Pmce6AnW')
on conflict (key) do nothing;

insert into public.config (key, value)
values ('pdf_url_en', 'https://drive.google.com/uc?export=download&id=1InJNU3HytwRgh4AsWFQmWTgzlw9Ob-AM')
on conflict (key) do nothing;

-- 3. STATS CACHE TABLE (V12 fix: avoids full table scan for KPIs)
create table if not exists public.subscriber_stats (
  id            int primary key default 1 check (id = 1),  -- singleton row
  total         bigint not null default 0,
  active        bigint not null default 0,
  newsletter    bigint not null default 0,
  unsubscribed  bigint not null default 0,
  lang_es       bigint not null default 0,
  lang_en       bigint not null default 0,
  updated_at    timestamptz not null default now()
);

-- Initialize stats row
insert into public.subscriber_stats (id) values (1) on conflict do nothing;

-- 4. RATE LIMIT TABLE (V2 fix: prevents signup spam)
create table if not exists public.signup_rate_limit (
  ip_hash     text primary key,
  attempts    int not null default 1,
  window_start timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════
-- 5. ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════
alter table public.subscribers enable row level security;
alter table public.config enable row level security;
alter table public.subscriber_stats enable row level security;
alter table public.signup_rate_limit enable row level security;

-- Subscribers: anyone can INSERT (signup form)
create policy "Anyone can subscribe"
  on public.subscribers for insert
  to anon, authenticated
  with check (status = 'active');

-- Subscribers: only authenticated users (admin) can SELECT, UPDATE, DELETE
create policy "Admin can read subscribers"
  on public.subscribers for select
  to authenticated
  using (true);

create policy "Admin can update subscribers"
  on public.subscribers for update
  to authenticated
  using (true)
  with check (true);

create policy "Admin can delete subscribers"
  on public.subscribers for delete
  to authenticated
  using (true);

-- Config: anyone can read (needed for PDF URL on form submit)
create policy "Anyone can read config"
  on public.config for select
  to anon, authenticated
  using (true);

-- Config: only admin can write
create policy "Admin can write config"
  on public.config for update
  to authenticated
  using (true)
  with check (true);

create policy "Admin can insert config"
  on public.config for insert
  to authenticated
  with check (true);

-- Stats: anyone can read (for potential public counters), only triggers can write
create policy "Anyone can read stats"
  on public.subscriber_stats for select
  to anon, authenticated
  using (true);

-- Rate limit: anon can insert/update (used during signup), admin can manage
create policy "Anon can use rate limit"
  on public.signup_rate_limit for all
  to anon, authenticated
  using (true)
  with check (true);

-- ═══════════════════════════════════════════════════
-- 6. TRIGGER: Update stats cache on subscriber changes
--    (V12 fix: instant KPIs without scanning 1M rows)
-- ═══════════════════════════════════════════════════
create or replace function public.update_stats_on_insert()
returns trigger
language plpgsql
security definer
as $$
begin
  update public.subscriber_stats set
    total        = total + 1,
    active       = active + 1,
    newsletter   = newsletter + (case when NEW.newsletter then 1 else 0 end),
    lang_es      = lang_es + (case when NEW.lang = 'es' then 1 else 0 end),
    lang_en      = lang_en + (case when NEW.lang = 'en' then 1 else 0 end),
    updated_at   = now()
  where id = 1;
  return NEW;
end;
$$;

create or replace function public.update_stats_on_update()
returns trigger
language plpgsql
security definer
as $$
begin
  -- Handle status change: active → unsubscribed
  if OLD.status = 'active' and NEW.status = 'unsubscribed' then
    update public.subscriber_stats set
      active       = active - 1,
      unsubscribed = unsubscribed + 1,
      newsletter   = newsletter - (case when OLD.newsletter then 1 else 0 end),
      updated_at   = now()
    where id = 1;
  end if;

  -- Handle status change: unsubscribed → active
  if OLD.status = 'unsubscribed' and NEW.status = 'active' then
    update public.subscriber_stats set
      active       = active + 1,
      unsubscribed = unsubscribed - 1,
      newsletter   = newsletter + (case when NEW.newsletter then 1 else 0 end),
      updated_at   = now()
    where id = 1;
  end if;

  return NEW;
end;
$$;

create or replace function public.update_stats_on_delete()
returns trigger
language plpgsql
security definer
as $$
begin
  update public.subscriber_stats set
    total        = total - 1,
    active       = active - (case when OLD.status = 'active' then 1 else 0 end),
    unsubscribed = unsubscribed - (case when OLD.status = 'unsubscribed' then 1 else 0 end),
    newsletter   = newsletter - (case when OLD.newsletter and OLD.status = 'active' then 1 else 0 end),
    lang_es      = lang_es - (case when OLD.lang = 'es' then 1 else 0 end),
    lang_en      = lang_en - (case when OLD.lang = 'en' then 1 else 0 end),
    updated_at   = now()
  where id = 1;
  return OLD;
end;
$$;

create trigger trg_stats_insert after insert on public.subscribers
  for each row execute function public.update_stats_on_insert();

create trigger trg_stats_update after update on public.subscribers
  for each row execute function public.update_stats_on_update();

create trigger trg_stats_delete after delete on public.subscribers
  for each row execute function public.update_stats_on_delete();

-- ═══════════════════════════════════════════════════
-- 7. DATABASE FUNCTIONS
-- ═══════════════════════════════════════════════════

-- Get dashboard stats from cache (instant, no table scan)
create or replace function public.get_dashboard_stats()
returns json
language plpgsql
security definer
stable
as $$
begin
  if auth.role() != 'authenticated' then
    raise exception 'Unauthorized';
  end if;

  return (
    select json_build_object(
      'total',        total,
      'active',       active,
      'newsletter',   newsletter,
      'unsubscribed', unsubscribed,
      'lang_es',      lang_es,
      'lang_en',      lang_en
    )
    from public.subscriber_stats
    where id = 1
  );
end;
$$;

-- Full-text search with pagination (V13 fix: uses GIN index via tsvector)
create or replace function public.search_subscribers(
  search_term text default '',
  filter_type text default 'all',
  page_size   int  default 50,
  page_offset int  default 0
)
returns table (
  id          bigint,
  name        text,
  email       text,
  lang        text,
  newsletter  boolean,
  status      text,
  email_sent  boolean,
  created_at  timestamptz,
  total_count bigint
)
language plpgsql
security definer
stable
as $$
begin
  if auth.role() != 'authenticated' then
    raise exception 'Unauthorized';
  end if;

  -- Clamp page_size to prevent abuse
  if page_size > 200 then
    page_size := 200;
  end if;

  return query
  select
    s.id, s.name, s.email, s.lang, s.newsletter, s.status, s.email_sent, s.created_at,
    count(*) over() as total_count
  from public.subscribers s
  where
    -- Filter
    (filter_type = 'all' or
     (filter_type = 'active' and s.status = 'active') or
     (filter_type = 'unsub'  and s.status = 'unsubscribed') or
     (filter_type = 'es'     and s.lang = 'es') or
     (filter_type = 'en'     and s.lang = 'en') or
     (filter_type = 'nl'     and s.newsletter = true and s.status = 'active'))
    -- Search: use tsvector for indexed full-text search when term provided
    and (search_term = '' or
         to_tsvector('simple', s.name || ' ' || s.email) @@ plainto_tsquery('simple', search_term) or
         s.email ilike search_term || '%')  -- also allow email prefix match
  order by s.created_at desc
  limit page_size
  offset page_offset;
end;
$$;

-- Rate-limited signup function (V2 fix: max 10 signups per IP per hour)
create or replace function public.rate_limited_signup(
  sub_name       text,
  sub_email      text,
  sub_lang       text,
  sub_newsletter boolean,
  client_ip_hash text
)
returns json
language plpgsql
security definer
as $$
declare
  result json;
begin
  -- Clean up old rate limit entries (older than 1 hour)
  delete from public.signup_rate_limit
  where window_start < now() - interval '1 hour';

  -- Check rate limit
  insert into public.signup_rate_limit (ip_hash, attempts, window_start)
  values (client_ip_hash, 1, now())
  on conflict (ip_hash) do update set
    attempts = case
      when signup_rate_limit.window_start < now() - interval '1 hour'
      then 1
      else signup_rate_limit.attempts + 1
    end,
    window_start = case
      when signup_rate_limit.window_start < now() - interval '1 hour'
      then now()
      else signup_rate_limit.window_start
    end;

  -- Check if over limit (10 signups per hour per IP)
  if (select attempts from public.signup_rate_limit where ip_hash = client_ip_hash) > 10 then
    return json_build_object('error', 'rate_limited', 'message', 'Too many signups. Try again later.');
  end if;

  -- Insert subscriber
  begin
    insert into public.subscribers (name, email, lang, newsletter, status)
    values (sub_name, lower(sub_email), sub_lang, sub_newsletter, 'active');
    return json_build_object('success', true);
  exception when unique_violation then
    -- Email already exists — not an error for the user
    return json_build_object('success', true, 'existing', true);
  end;
end;
$$;

-- NOTE: export_subscribers_csv() removed (V6 fix)
-- CSV export is handled by the Edge Function which paginates efficiently
