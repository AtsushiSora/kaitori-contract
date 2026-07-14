create table if not exists public.contracts (
  id text primary key,
  status text not null default '下書き',
  data jsonb not null default '{}'::jsonb,
  signature_data text,
  identity_files jsonb not null default '[]'::jsonb,
  consent_status text,
  consent_result jsonb,
  remote_access_hash text,
  remote_access_expires_at timestamptz,
  remote_used_at timestamptz,
  created_at_text text,
  updated_at_text text,
  completed_at_text text,
  signed_at_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.contracts
  add column if not exists remote_access_hash text,
  add column if not exists remote_access_expires_at timestamptz,
  add column if not exists remote_used_at timestamptz;

create table if not exists public.consent_events (
  id bigint generated always as identity primary key,
  contract_id text not null references public.contracts(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.contracts enable row level security;
alter table public.consent_events enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.contracts to authenticated;
grant select on table public.consent_events to authenticated;

drop policy if exists "authenticated users can manage contracts" on public.contracts;
create policy "authenticated users can manage contracts"
on public.contracts
for all
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated users can read consent events" on public.consent_events;
create policy "authenticated users can read consent events"
on public.consent_events
for select
to authenticated
using (true);

insert into storage.buckets (id, name, public)
values ('contract-files', 'contract-files', false)
on conflict (id) do nothing;

drop policy if exists "authenticated users can manage contract files" on storage.objects;
create policy "authenticated users can manage contract files"
on storage.objects
for all
to authenticated
using (bucket_id = 'contract-files')
with check (bucket_id = 'contract-files');
