alter table public.contracts
  add column if not exists customer_pdf_path text,
  add column if not exists download_access_hash text,
  add column if not exists download_access_expires_at timestamptz;

create unique index if not exists contracts_download_access_hash_key
  on public.contracts (download_access_hash)
  where download_access_hash is not null;
