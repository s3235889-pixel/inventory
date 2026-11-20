-- Successful delivery uploads are immutable. Existing rows are left untouched.
-- Creation and exact retries remain supported; the existing delete RPC still
-- uses a tombstone and may update only its deletion metadata.
create or replace function public.save_delivery_record(
  p_store_id integer, p_id uuid, p_request_id uuid, p_expected_version integer,
  p_record jsonb, p_photo_path text, p_remove_photo boolean, p_request_fingerprint text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  existing public.delivery_records%rowtype;
  saved public.delivery_records%rowtype;
  has_existing boolean;
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
  if p_expected_version <> 0 or p_remove_photo then
    raise exception using errcode = '55000', message = '外送紀錄上傳後不可再編輯';
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
  if p_photo_path is not null and (
      not starts_with(p_photo_path, p_store_id::text || '/' || p_id::text || '/') or
      p_photo_path !~ '^[0-9]+/[0-9a-f-]{36}/[0-9a-f-]{36}-[0-9a-f]{64}\.(jpg|png|webp)$') then
    raise exception using errcode = '22023', message = '單據照片路徑無效';
  end if;
  -- All stores and both save/delete RPCs serialize against the same UUID.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 273901));
  select * into existing from public.delivery_records where id = p_id;
  has_existing := found;
  if has_existing and existing.store_id <> p_store_id then
    raise exception using errcode = '42501', message = '沒有權限操作此紀錄';
  end if;
  if has_existing and existing.deleted_at is not null then
    raise exception using errcode = '40001', message = '此紀錄已刪除，請重新載入';
  end if;
  if has_existing then
    if existing.last_request_id = p_request_id
       and existing.last_request_fingerprint = p_request_fingerprint
       and existing.unit_name = p_record ->> 'unit_name'
       and existing.address = p_record ->> 'address'
       and existing.courier = p_record ->> 'courier'
       and existing.delivered_at = delivered
       and existing.amount = (p_record ->> 'amount')::numeric
       and existing.distance_km = (p_record ->> 'distance_km')::numeric
       and (substr(split_part(existing.photo_path, '/', 3), 38)
         is not distinct from substr(split_part(p_photo_path, '/', 3), 38)) then
      -- The physical object UUID differs per attempt, but the photo hash/format
      -- must match. Return the committed path so only this retry is cleaned up.
      return jsonb_build_object('record', public.delivery_record_json(existing),
        'photo_path', existing.photo_path, 'unused_photo_paths', '[]'::jsonb);
    end if;
    raise exception using errcode = '55000', message = '外送紀錄上傳後不可再編輯';
  end if;
  insert into public.delivery_records
    (id, store_id, unit_name, address, courier, delivered_at, amount, distance_km, photo_path, last_request_id, last_request_fingerprint)
    values (p_id, p_store_id, p_record ->> 'unit_name', p_record ->> 'address', p_record ->> 'courier', delivered,
      (p_record ->> 'amount')::numeric, (p_record ->> 'distance_km')::numeric, p_photo_path, p_request_id, p_request_fingerprint)
    returning * into saved;
  return jsonb_build_object('record', public.delivery_record_json(saved), 'photo_path', saved.photo_path,
    'unused_photo_paths', '[]'::jsonb);
end;
$$;
revoke all on function public.save_delivery_record(integer, uuid, uuid, integer, jsonb, text, boolean, text) from public, anon, authenticated;
grant execute on function public.save_delivery_record(integer, uuid, uuid, integer, jsonb, text, boolean, text) to service_role;

-- Enforce immutability even if another service-role code path bypasses the RPC.
-- Everything except the three deletion metadata fields is immutable, including
-- future business columns. Tombstones cannot be restored or rewritten.
create function public.enforce_delivery_record_immutability()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if to_jsonb(new) is not distinct from to_jsonb(old) then return new; end if;
  if (to_jsonb(new) - array['deleted_at', 'version', 'updated_at'])
       is distinct from (to_jsonb(old) - array['deleted_at', 'version', 'updated_at'])
     or old.deleted_at is not null or new.deleted_at is null
     or new.version is distinct from old.version + 1 then
    raise exception using errcode = '55000', message = '外送紀錄上傳後不可再編輯';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_delivery_record_immutability() from public, anon, authenticated;
grant execute on function public.enforce_delivery_record_immutability() to service_role;
create trigger delivery_records_immutable_before_update
  before update on public.delivery_records
  for each row execute function public.enforce_delivery_record_immutability();
