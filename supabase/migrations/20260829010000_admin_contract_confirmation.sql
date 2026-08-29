alter table public.contracts
  add column if not exists reviewed_at timestamptz,
  add column if not exists customer_confirmation_sent_at timestamptz,
  add column if not exists confirmation_email_status text;
