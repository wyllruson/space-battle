-- =============================================================================
-- Space Battle leaderboard (Supabase → SQL Editor)
-- =============================================================================
-- MAX_LEADERBOARD_ENTRIES must match frontend/script.js (currently 6).

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------

create table if not exists public.scores (
    id bigint generated always as identity primary key,
    name text not null check (char_length(name) between 1 and 50),
    score integer not null check (score >= 0),
    created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Index (score desc, oldest first on ties — same order as the client)
-- -----------------------------------------------------------------------------

create index if not exists scores_leaderboard_idx
    on public.scores (score desc, created_at asc);

-- -----------------------------------------------------------------------------
-- Row-level security (anon read + insert only; prune runs as security definer)
-- -----------------------------------------------------------------------------

alter table public.scores enable row level security;

drop policy if exists "Allow public read" on public.scores;
create policy "Allow public read"
    on public.scores for select
    using (true);

drop policy if exists "Allow public insert" on public.scores;
create policy "Allow public insert"
    on public.scores for insert
    with check (true);

-- -----------------------------------------------------------------------------
-- Prune to top N (single implementation used by trigger and one-time trim)
-- -----------------------------------------------------------------------------

drop function if exists public.prune_scores_to_top_six() cascade;

create or replace function public.leaderboard_max_entries()
returns integer
language sql
immutable
as $$ select 6; $$;

create or replace function public.prune_scores()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    delete from public.scores
    where id not in (
        select id
        from public.scores
        order by score desc, created_at asc
        limit public.leaderboard_max_entries()
    );
end;
$$;

create or replace function public.prune_scores_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    perform public.prune_scores();
    return null;
end;
$$;

drop trigger if exists scores_prune_after_insert on public.scores;

create trigger scores_prune_after_insert
    after insert on public.scores
    for each row
    execute function public.prune_scores_after_insert();

-- -----------------------------------------------------------------------------
-- One-time trim when applying or re-applying this schema
-- -----------------------------------------------------------------------------

select public.prune_scores();
