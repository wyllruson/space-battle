-- Supabase → SQL Editor: run to create the leaderboard table and policies.

-- Table
create table if not exists public.scores (
    id bigint generated always as identity primary key,
    name text not null check (char_length(name) between 1 and 50),
    score integer not null check (score >= 0),
    created_at timestamptz not null default now()
);

-- Index for leaderboard queries (score desc, oldest first on ties)
create index if not exists scores_leaderboard_idx
    on public.scores (score desc, created_at asc);

-- Row-level security
alter table public.scores enable row level security;

create policy "Allow public read"
    on public.scores for select
    using (true);

create policy "Allow public insert"
    on public.scores for insert
    with check (true);
