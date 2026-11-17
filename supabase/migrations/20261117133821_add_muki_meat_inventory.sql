-- MUKI daily meat count. Raw observations only; usage is recalculated from adjacent dates.
-- The existing receipt login issues the branch token verified by meat-inventory-api.

create or replace function public.muki_meats_valid(p_meats jsonb)
returns boolean
language plpgsql immutable security invoker
set search_path = ''
as $$
declare
  meat_key text;
  field_key text;
  meat jsonb;
  amount numeric;
begin
  if p_meats is null or jsonb_typeof(p_meats) is distinct from 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(p_meats)) <> 3 then return false; end if;
  foreach meat_key in array array['beef','pork','chicken'] loop
    meat := p_meats -> meat_key;
    if jsonb_typeof(meat) is distinct from 'object' then return false; end if;
    if (select count(*) from jsonb_object_keys(meat)) <> 5 then return false; end if;
    foreach field_key in array array['closing','thaw','extra','waste','target'] loop
      if not (meat ? field_key) then return false; end if;
      if field_key = 'target' and meat -> field_key = 'null'::jsonb then continue; end if;
      if jsonb_typeof(meat -> field_key) is distinct from 'number' then return false; end if;
      amount := (meat ->> field_key)::numeric;
      if amount < 0 or amount > 10000 or trunc(amount, 1) <> amount then return false; end if;
    end loop;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;
revoke all on function public.muki_meats_valid(jsonb) from public, anon, authenticated;
grant execute on function public.muki_meats_valid(jsonb) to service_role;

create table public.meat_inventory_days (
  store_id integer not null references public.stores(store_id),
  business_date date not null check (business_date >= date '1900-01-01'),
  meats jsonb not null check (public.muki_meats_valid(meats)),
  note text not null default '' check (char_length(note) <= 500),
  version integer not null default 1 check (version > 0),
  last_request_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (store_id, business_date)
);
alter table public.meat_inventory_days enable row level security;
revoke all on public.meat_inventory_days from public, anon, authenticated;
grant select, insert, update on public.meat_inventory_days to service_role;
comment on table public.meat_inventory_days is '木崎每日肉品盤點；只能透過驗證木崎門市 token 的 Edge Function 存取。';

create or replace function public.save_muki_meat_day(
  p_store_id integer,
  p_date date,
  p_meats jsonb,
  p_note text,
  p_expected_version integer,
  p_request_id uuid
) returns jsonb
language plpgsql security invoker
set search_path = ''
as $$
declare
  existing public.meat_inventory_days%rowtype;
  previous public.meat_inventory_days%rowtype;
  following public.meat_inventory_days%rowtype;
  saved public.meat_inventory_days%rowtype;
  has_existing boolean;
  has_previous boolean;
  has_following boolean;
  meat_key text;
  meat_name text;
  used numeric;
begin
  if not exists (select 1 from public.stores where store_id = p_store_id and store_name = '木崎(C2)') then
    raise exception using errcode = '42501', message = '此功能僅限木崎門市';
  end if;
  if p_date is null or p_date < date '1900-01-01' or p_date > (now() at time zone 'Asia/Taipei')::date then
    raise exception using errcode = '22023', message = '請選擇今天或以前的有效盤點日期';
  end if;
  if not public.muki_meats_valid(p_meats) then
    raise exception using errcode = '22023', message = '請完整填寫三種肉品份數（0 至 10000，最多一位小數）';
  end if;
  if p_note is null or char_length(p_note) > 500 then
    raise exception using errcode = '22023', message = '備註最多 500 個字';
  end if;
  if p_expected_version is null or p_expected_version < 0 or p_request_id is null then
    raise exception using errcode = '22023', message = '儲存資料不完整，請重新載入';
  end if;

  -- Serialize this branch's adjacent-day edits, including the first insert.
  perform pg_advisory_xact_lock(793121, p_store_id);
  select * into existing from public.meat_inventory_days
    where store_id = p_store_id and business_date = p_date;
  has_existing := found;
  if has_existing and existing.last_request_id = p_request_id then
    if existing.meats = p_meats and existing.note = p_note then
      return to_jsonb(existing) - 'store_id' - 'last_request_id' - 'created_at';
    end if;
    raise exception using errcode = '40001', message = '同一儲存請求的內容不同，請重新載入';
  end if;
  if (has_existing and existing.version <> p_expected_version)
     or (not has_existing and p_expected_version <> 0) then
    raise exception using errcode = '40001', message = '這一天已在另一個畫面更新，請重新載入後再編輯';
  end if;
  select * into previous from public.meat_inventory_days
    where store_id = p_store_id and business_date = p_date - 1;
  has_previous := found;
  select * into following from public.meat_inventory_days
    where store_id = p_store_id and business_date = p_date + 1;
  has_following := found;

  foreach meat_key in array array['beef','pork','chicken'] loop
    meat_name := case meat_key when 'beef' then '牛五花' when 'pork' then '豚梅花' else '雞胸肉' end;
    if has_previous then
      used := (previous.meats -> meat_key ->> 'closing')::numeric
            + (previous.meats -> meat_key ->> 'thaw')::numeric
            + (p_meats -> meat_key ->> 'extra')::numeric
            - (p_meats -> meat_key ->> 'closing')::numeric
            - (p_meats -> meat_key ->> 'waste')::numeric;
      if used < 0 then
        raise exception using errcode = '22023',
          message = meat_name || '：冷藏剩餘與耗損超過今日可用，請確認盤點或今日追加退冰';
      end if;
    end if;
    if has_following then
      used := (p_meats -> meat_key ->> 'closing')::numeric
            + (p_meats -> meat_key ->> 'thaw')::numeric
            + (following.meats -> meat_key ->> 'extra')::numeric
            - (following.meats -> meat_key ->> 'closing')::numeric
            - (following.meats -> meat_key ->> 'waste')::numeric;
      if used < 0 then
        raise exception using errcode = '22023',
          message = meat_name || '：這次修改會讓隔日用量變成負數，請先核對隔日盤點或追加退冰';
      end if;
    end if;
  end loop;

  if has_existing then
    update public.meat_inventory_days
      set meats = p_meats, note = p_note, version = existing.version + 1,
          last_request_id = p_request_id, updated_at = clock_timestamp()
      where store_id = p_store_id and business_date = p_date returning * into saved;
  else
    insert into public.meat_inventory_days(store_id, business_date, meats, note, last_request_id)
      values (p_store_id, p_date, p_meats, p_note, p_request_id) returning * into saved;
  end if;
  return to_jsonb(saved) - 'store_id' - 'last_request_id' - 'created_at';
end;
$$;
revoke all on function public.save_muki_meat_day(integer, date, jsonb, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.save_muki_meat_day(integer, date, jsonb, text, integer, uuid) to service_role;

-- Branch passwords must not be readable or replaceable from a public browser.
-- Existing pages use only these three directory columns; receipt-api verifies passwords server-side.
revoke all privileges on table public.stores from public, anon, authenticated;
revoke all privileges (store_id, store_name, sort_order, password) on public.stores from public, anon, authenticated;
grant select (store_id, store_name, sort_order) on public.stores to anon, authenticated;
alter table public.stores enable row level security;
drop policy if exists "Allow All Stores" on public.stores;
create policy stores_directory_read on public.stores for select to anon, authenticated using (true);
