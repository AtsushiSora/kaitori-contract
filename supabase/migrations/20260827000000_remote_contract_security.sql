alter table public.contracts
  add column if not exists remote_link_hash text,
  add column if not exists remote_failed_attempts integer not null default 0,
  add column if not exists remote_locked_until timestamptz,
  add column if not exists parent_contract_id text,
  add column if not exists version_number integer not null default 1,
  add column if not exists locked_at timestamptz;

create index if not exists contracts_remote_link_hash_idx
  on public.contracts (remote_link_hash)
  where remote_link_hash is not null;

create index if not exists contracts_parent_contract_id_idx
  on public.contracts (parent_contract_id)
  where parent_contract_id is not null;

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

alter table public.admin_notifications enable row level security;

grant select, update, delete on table public.admin_notifications to authenticated;
grant insert on table public.admin_notifications to service_role;
grant usage, select on sequence public.admin_notifications_id_seq to service_role;

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
on conflict (id) do update set public = false;

drop policy if exists "authenticated users can manage contract files" on storage.objects;
create policy "authenticated users can manage contract files"
on storage.objects
for all
to authenticated
using (bucket_id = 'contract-files')
with check (bucket_id = 'contract-files');
