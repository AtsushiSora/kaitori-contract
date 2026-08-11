alter table public.contracts
  add column if not exists contract_number text;

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
