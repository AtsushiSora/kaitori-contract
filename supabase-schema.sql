create table if not exists public.contracts (
  id text primary key,
  status text not null default '下書き',
  data jsonb not null default '{}'::jsonb,
  signature_data text,
  identity_files jsonb not null default '[]'::jsonb,
  consent_status text,
  consent_result jsonb,
  remote_access_hash text,
  remote_link_hash text,
  remote_access_expires_at timestamptz,
  remote_used_at timestamptz,
  remote_failed_attempts integer not null default 0,
  remote_locked_until timestamptz,
  customer_pdf_path text,
  download_access_hash text,
  download_access_expires_at timestamptz,
  reviewed_at timestamptz,
  customer_confirmation_sent_at timestamptz,
  confirmation_email_status text,
  parent_contract_id text,
  version_number integer not null default 1,
  locked_at timestamptz,
  created_at_text text,
  updated_at_text text,
  completed_at_text text,
  signed_at_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.contracts
  add column if not exists remote_access_hash text,
  add column if not exists remote_link_hash text,
  add column if not exists remote_access_expires_at timestamptz,
  add column if not exists remote_used_at timestamptz,
  add column if not exists remote_failed_attempts integer not null default 0,
  add column if not exists remote_locked_until timestamptz,
  add column if not exists customer_pdf_path text,
  add column if not exists download_access_hash text,
  add column if not exists download_access_expires_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists customer_confirmation_sent_at timestamptz,
  add column if not exists confirmation_email_status text,
  add column if not exists parent_contract_id text,
  add column if not exists version_number integer not null default 1,
  add column if not exists locked_at timestamptz,
  add column if not exists contract_number text;

create index if not exists contracts_remote_link_hash_idx
  on public.contracts (remote_link_hash)
  where remote_link_hash is not null;

create index if not exists contracts_parent_contract_id_idx
  on public.contracts (parent_contract_id)
  where parent_contract_id is not null;

create unique index if not exists contracts_download_access_hash_key
  on public.contracts (download_access_hash)
  where download_access_hash is not null;

create unique index if not exists contracts_contract_number_key
  on public.contracts (contract_number)
  where contract_number is not null;

create table if not exists public.contract_number_sequences (
  sequence_date date primary key,
  last_value smallint not null check (last_value between 1 and 99),
  updated_at timestamptz not null default now()
);

alter table public.contract_number_sequences enable row level security;

create or replace function public.assign_contract_number(
  p_contract_id text,
  p_preferred_number text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_number text;
  assigned_number text;
  sequence_value smallint;
  next_existing_value smallint;
  sequence_date_jst date := (timezone('Asia/Tokyo', now()))::date;
begin
  if auth.uid() is null then
    raise exception 'Administrator authentication is required' using errcode = '42501';
  end if;
  if p_contract_id is null or length(trim(p_contract_id)) = 0 or length(p_contract_id) > 100 then
    raise exception 'Invalid contract id' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('order-auto-contract-number'));

  select contract_number
    into current_number
    from public.contracts
   where id = p_contract_id
   for update;

  if current_number is not null then
    return current_number;
  end if;

  if p_preferred_number ~ '^[0-9]{1,8}$'
     and not exists (
       select 1
         from public.contracts
        where contract_number = p_preferred_number
          and id <> p_contract_id
     ) then
    assigned_number := p_preferred_number;
  else
    select coalesce(max(right(contract_number, 2)::smallint), 0) + 1
      into next_existing_value
      from public.contracts
     where contract_number ~ ('^' || to_char(sequence_date_jst, 'YYMMDD') || '[0-9]{2}$');

    if next_existing_value > 99 then
      raise exception 'Daily contract number limit reached' using errcode = '22000';
    end if;

    insert into public.contract_number_sequences (sequence_date, last_value, updated_at)
    values (sequence_date_jst, next_existing_value, now())
    on conflict (sequence_date) do update
      set last_value = greatest(
            public.contract_number_sequences.last_value,
            excluded.last_value - 1
          ) + 1,
          updated_at = now()
      where greatest(
              public.contract_number_sequences.last_value,
              excluded.last_value - 1
            ) < 99
    returning last_value into sequence_value;

    if sequence_value is null then
      raise exception 'Daily contract number limit reached' using errcode = '22000';
    end if;

    assigned_number :=
      to_char(sequence_date_jst, 'YYMMDD') || lpad(sequence_value::text, 2, '0');
  end if;

  insert into public.contracts (id, contract_number, updated_at)
  values (p_contract_id, assigned_number, now())
  on conflict (id) do update
    set contract_number = coalesce(public.contracts.contract_number, excluded.contract_number),
        updated_at = now()
  returning contract_number into current_number;

  return current_number;
end;
$$;

revoke all on table public.contract_number_sequences from anon, authenticated;
revoke all on function public.assign_contract_number(text, text) from public, anon;
grant execute on function public.assign_contract_number(text, text) to authenticated;

create table if not exists public.consent_events (
  id bigint generated always as identity primary key,
  contract_id text not null references public.contracts(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_notifications (
  id bigint generated always as identity primary key,
  contract_id text references public.contracts(id) on delete cascade,
  notification_type text not null,
  title text not null,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.contracts enable row level security;
alter table public.consent_events enable row level security;
alter table public.admin_notifications enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.contracts to authenticated;
grant select on table public.consent_events to authenticated;
grant select, update, delete on table public.admin_notifications to authenticated;

-- Edge Functions use the service role after validating the one-time access token.
grant usage on schema public to service_role;
grant select, update on table public.contracts to service_role;
grant insert on table public.consent_events to service_role;
grant insert on table public.admin_notifications to service_role;
grant usage, select on sequence public.consent_events_id_seq to service_role;
grant usage, select on sequence public.admin_notifications_id_seq to service_role;

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

drop policy if exists "authenticated users can manage admin notifications" on public.admin_notifications;
create policy "authenticated users can manage admin notifications"
on public.admin_notifications
for all
to authenticated
using (true)
with check (true);

create or replace function public.prevent_completed_contract_overwrite()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = '完了' and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Completed contracts are locked. Create a new version instead.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_completed_contracts on public.contracts;
create trigger protect_completed_contracts
before update on public.contracts
for each row
execute function public.prevent_completed_contract_overwrite();

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
