-- 外送記錄與單據照片，只供已驗證的潮州店(C1)和木崎(C2)使用。
-- Browser roles have no direct table/RPC/storage access; delivery-api verifies the
-- existing receipt HMAC login and scopes every operation to its signed store ID.

create table public.delivery_records (
  id uuid primary key,
  store_id integer not null references public.stores(store_id) check (store_id in (1, 2)),
  unit_name text not null check (char_length(unit_name) between 1 and 100 and unit_name = btrim(unit_name) and unit_name ~ '[^[:space:]]'),
  address text not null check (char_length(address) between 1 and 300 and address = btrim(address) and address ~ '[^[:space:]]'),
  courier text not null check (char_length(courier) between 1 and 60 and courier = btrim(courier) and courier ~ '[^[:space:]]'),
  delivered_at timestamptz not null check (isfinite(delivered_at)
    and delivered_at >= timestamptz '1900-01-01 00:00:00+08'
    and delivered_at < timestamptz '10000-01-01 00:00:00+08'),
  amount numeric not null check (amount >= 0 and amount <= 99999999.99 and amount = trunc(amount, 2)),
  distance_km numeric not null check (distance_km >= 0 and distance_km <= 99999.99 and distance_km = trunc(distance_km, 2)),
  photo_path text check (photo_path is null or (
    starts_with(photo_path, store_id::text || '/' || id::text || '/')
    and photo_path ~ '^[0-9]+/[0-9a-f-]{36}/[0-9a-f-]{36}-[0-9a-f]{64}\.(jpg|png|webp)$')),
  version integer not null default 1 check (version > 0),
  last_request_id uuid not null,
  last_request_fingerprint text not null check (last_request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz
);
create index delivery_records_store_date on public.delivery_records (store_id, delivered_at desc, id)
  where deleted_at is null;
alter table public.delivery_records enable row level security;
revoke all on public.delivery_records from public, anon, authenticated;
grant select, insert, update on public.delivery_records to service_role;
comment on table public.delivery_records is '潮州與木崎外送記錄；只由驗證門市 token 的 delivery-api 存取。已刪除資料不再對應用程式可見，保留 tombstone 避免舊請求復活。';

create function public.delivery_record_json(p_row public.delivery_records)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id', p_row.id, 'unit_name', p_row.unit_name, 'address', p_row.address,
    'courier', p_row.courier, 'delivered_at', p_row.delivered_at,
    'amount', p_row.amount, 'distance_km', p_row.distance_km,
    'has_photo', p_row.photo_path is not null, 'version', p_row.version, 'updated_at', p_row.updated_at
  );
$$;
revoke all on function public.delivery_record_json(public.delivery_records) from public, anon, authenticated;
grant execute on function public.delivery_record_json(public.delivery_records) to service_role;

create function public.load_delivery_records(p_store_id integer, p_month text, p_page integer default 0)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  first_day date;
  start_at timestamptz;
  end_at timestamptz;
  result jsonb;
begin
  if p_store_id is null or p_store_id not in (1, 2) then
    raise exception using errcode = '42501', message = '外送記錄僅限潮州店與木崎使用';
  end if;
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or p_month < '1900-01'
     or p_page is null or p_page < 0 or p_page > 100000 then
    raise exception using errcode = '22023', message = '月份或頁碼無效';
  end if;
  first_day := (p_month || '-01')::date;
  start_at := first_day::timestamp at time zone 'Asia/Taipei';
  end_at := (first_day::timestamp + interval '1 month') at time zone 'Asia/Taipei';
  select jsonb_build_object(
    'total_count', count(*), 'total_amount', coalesce(sum(amount), 0),
    'total_distance_km', coalesce(sum(distance_km), 0)
  ) into result from public.delivery_records
    where store_id = p_store_id and deleted_at is null
      and delivered_at >= start_at and delivered_at < end_at;
  return result || jsonb_build_object('records', coalesce((
    select jsonb_agg(public.delivery_record_json(page_row::public.delivery_records) order by page_row.delivered_at desc, page_row.id)
      from (
        select * from public.delivery_records
          where store_id = p_store_id and deleted_at is null
            and delivered_at >= start_at and delivered_at < end_at
          order by delivered_at desc, id limit 50 offset p_page * 50
      ) page_row
  ), '[]'::jsonb));
end;
$$;
revoke all on function public.load_delivery_records(integer, text, integer) from public, anon, authenticated;
grant execute on function public.load_delivery_records(integer, text, integer) to service_role;

create function public.save_delivery_record(
  p_store_id integer, p_id uuid, p_request_id uuid, p_expected_version integer,
  p_record jsonb, p_photo_path text, p_remove_photo boolean, p_request_fingerprint text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  existing public.delivery_records%rowtype;
  saved public.delivery_records%rowtype;
  has_existing boolean;
  upload_path text;
  old_photo text;
  delivered timestamptz;
begin
  if p_store_id is null or p_store_id not in (1, 2) then
    raise exception using errcode = '42501', message = '外送記錄僅限潮州店與木崎使用';
  end if;
  if p_id is null or p_request_id is null or p_expected_version is null or p_expected_version < 0
     or p_expected_version >= 2147483647 or p_remove_photo is null
     or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = '儲存識別或版本無效';
  end if;
  if p_record is null or jsonb_typeof(p_record) is distinct from 'object' then
    raise exception using errcode = '22023', message = '外送資料格式錯誤';
  end if;
  if (select count(*) from jsonb_object_keys(p_record)) <> 6
     or not (p_record ?& array['unit_name', 'address', 'courier', 'delivered_at', 'amount', 'distance_km'])
     or jsonb_typeof(p_record -> 'unit_name') is distinct from 'string'
     or jsonb_typeof(p_record -> 'address') is distinct from 'string'
     or jsonb_typeof(p_record -> 'courier') is distinct from 'string'
     or jsonb_typeof(p_record -> 'delivered_at') is distinct from 'string'
     or jsonb_typeof(p_record -> 'amount') is distinct from 'number'
     or jsonb_typeof(p_record -> 'distance_km') is distinct from 'number' then
    raise exception using errcode = '22023', message = '請完整填寫六項外送資料';
  end if;
  begin
    delivered := (p_record ->> 'delivered_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = '22023', message = '外送日期時間無效';
  end;
  if p_photo_path is not null and (p_remove_photo or
      not starts_with(p_photo_path, p_store_id::text || '/' || p_id::text || '/') or
      p_photo_path !~ '^[0-9]+/[0-9a-f-]{36}/[0-9a-f-]{36}-[0-9a-f]{64}\.(jpg|png|webp)$') then
    raise exception using errcode = '22023', message = '單據照片路徑無效';
  end if;
  -- Covers first insertion as well as updates/deletes; all stores lock the same UUID.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 273901));
  select * into existing from public.delivery_records where id = p_id;
  has_existing := found;
  if has_existing and existing.store_id <> p_store_id then
    raise exception using errcode = '42501', message = '沒有權限操作此紀錄';
  end if;
  if has_existing and existing.deleted_at is not null then
    raise exception using errcode = '40001', message = '此紀錄已刪除，請重新載入';
  end if;
  if has_existing and existing.last_request_id = p_request_id then
    if existing.last_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = '同一請求的內容已變更，請重新載入';
    end if;
    -- A retry may have uploaded a different physical object with identical content.
    -- Return the committed path; the caller removes only its own unused attempt.
    return jsonb_build_object('record', public.delivery_record_json(existing),
      'photo_path', existing.photo_path, 'unused_photo_paths', '[]'::jsonb);
  end if;
  if (has_existing and existing.version <> p_expected_version)
     or (not has_existing and p_expected_version <> 0) then
    raise exception using errcode = '40001', message = '外送紀錄已在另一個畫面更新，請重新載入';
  end if;
  old_photo := case when has_existing then existing.photo_path else null end;
  upload_path := case when p_remove_photo then null when p_photo_path is not null then p_photo_path else old_photo end;
  if has_existing then
    update public.delivery_records set
      unit_name = p_record ->> 'unit_name', address = p_record ->> 'address', courier = p_record ->> 'courier',
      delivered_at = delivered, amount = (p_record ->> 'amount')::numeric, distance_km = (p_record ->> 'distance_km')::numeric,
      photo_path = upload_path, version = existing.version + 1, last_request_id = p_request_id,
      last_request_fingerprint = p_request_fingerprint, updated_at = clock_timestamp()
      where id = p_id and store_id = p_store_id returning * into saved;
  else
    insert into public.delivery_records
      (id, store_id, unit_name, address, courier, delivered_at, amount, distance_km, photo_path, last_request_id, last_request_fingerprint)
      values (p_id, p_store_id, p_record ->> 'unit_name', p_record ->> 'address', p_record ->> 'courier', delivered,
        (p_record ->> 'amount')::numeric, (p_record ->> 'distance_km')::numeric, upload_path, p_request_id, p_request_fingerprint)
      returning * into saved;
  end if;
  return jsonb_build_object('record', public.delivery_record_json(saved), 'photo_path', saved.photo_path,
    'unused_photo_paths', case when old_photo is not null and old_photo is distinct from saved.photo_path
      then jsonb_build_array(old_photo) else '[]'::jsonb end);
end;
$$;
revoke all on function public.save_delivery_record(integer, uuid, uuid, integer, jsonb, text, boolean, text) from public, anon, authenticated;
grant execute on function public.save_delivery_record(integer, uuid, uuid, integer, jsonb, text, boolean, text) to service_role;

create function public.delete_delivery_record(p_store_id integer, p_id uuid, p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  existing public.delivery_records%rowtype;
begin
  if p_store_id is null or p_store_id not in (1, 2) then
    raise exception using errcode = '42501', message = '外送記錄僅限潮州店與木崎使用';
  end if;
  if p_id is null or p_expected_version is null or p_expected_version < 1 or p_expected_version >= 2147483647 then
    raise exception using errcode = '22023', message = '刪除識別或版本無效';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 273901));
  select * into existing from public.delivery_records where id = p_id and store_id = p_store_id;
  if not found then raise exception using errcode = 'P0002', message = '找不到此外送紀錄'; end if;
  if existing.deleted_at is not null then
    if existing.version <> p_expected_version + 1 then
      raise exception using errcode = '40001', message = '紀錄版本已變更，請重新載入';
    end if;
    return jsonb_build_object('ok', true, 'photo_path', existing.photo_path);
  end if;
  if existing.version <> p_expected_version then
    raise exception using errcode = '40001', message = '此紀錄已由另一個畫面更新，請重新載入';
  end if;
  update public.delivery_records set deleted_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
    where id = p_id and store_id = p_store_id;
  return jsonb_build_object('ok', true, 'photo_path', existing.photo_path);
end;
$$;
revoke all on function public.delete_delivery_record(integer, uuid, integer) from public, anon, authenticated;
grant execute on function public.delete_delivery_record(integer, uuid, integer) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('delivery-photos', 'delivery-photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp']);
-- Defense in depth: an unrelated permissive storage policy must never make this
-- bucket readable or writable by browser roles. The Edge Function uses service_role.
create policy delivery_photos_private on storage.objects as restrictive for all to anon, authenticated
  using (bucket_id <> 'delivery-photos') with check (bucket_id <> 'delivery-photos');
