-- Administrator-only correction paths. Store RPCs and service_role keep their
-- existing INSERT/SELECT-only privileges; no original delivery row is changed
-- by this migration. The Edge Function verifies the signed admin session, and
-- mutation RPCs recheck its current session_version before doing any work.
create role delivery_admin_writer nologin nosuperuser nocreatedb nocreaterole
  noreplication nobypassrls noinherit;
-- PostgreSQL 16+ already gives a CREATEROLE creator ADMIN OPTION through its
-- bootstrap grantor. A plain membership grant adds SET/INHERIT for ownership
-- and future maintenance, without attempting an invalid self ADMIN grant.
-- No API role is a member of the writer role.
grant delivery_admin_writer to postgres;
grant usage, create on schema public to delivery_admin_writer;

grant select, insert on public.delivery_records to delivery_admin_writer;
grant update (unit_name, address, courier, delivered_at, amount, distance_km,
  vehicle_type, version, updated_at, deleted_at)
  on public.delivery_records to delivery_admin_writer;
create policy delivery_records_admin_read on public.delivery_records
  for select to delivery_admin_writer using (store_id in (1, 2));
create policy delivery_records_admin_insert on public.delivery_records
  for insert to delivery_admin_writer with check (store_id in (1, 2));
create policy delivery_records_admin_update on public.delivery_records
  for update to delivery_admin_writer using (store_id in (1, 2))
  with check (store_id in (1, 2));
grant select on public.delivery_photo_attachments to delivery_admin_writer;
create policy delivery_attachments_admin_read on public.delivery_photo_attachments
  for select to delivery_admin_writer using (store_id in (1, 2));
grant select (id, session_version) on public.receipt_admin_config to delivery_admin_writer;
create policy delivery_admin_session_version_read on public.receipt_admin_config
  for select to delivery_admin_writer using (id = 1);

create table public.delivery_admin_mutations (
  request_id uuid primary key,
  record_id uuid not null references public.delivery_records(id),
  store_id integer not null check (store_id in (1, 2)),
  action text not null check (action in ('create', 'update', 'delete')),
  expected_version integer not null check (expected_version >= 0),
  admin_session_version integer not null check (admin_session_version > 0),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
  before_record jsonb,
  after_record jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index delivery_admin_mutations_record_date
  on public.delivery_admin_mutations (record_id, created_at desc);
alter table public.delivery_admin_mutations enable row level security;
revoke all on public.delivery_admin_mutations from public, anon, authenticated, service_role;
grant select on public.delivery_admin_mutations to service_role;
grant select, insert on public.delivery_admin_mutations to delivery_admin_writer;
create policy delivery_admin_mutations_read on public.delivery_admin_mutations
  for select to delivery_admin_writer using (store_id in (1, 2));
create policy delivery_admin_mutations_insert on public.delivery_admin_mutations
  for insert to delivery_admin_writer with check (store_id in (1, 2));
comment on table public.delivery_admin_mutations is '管理者外送新增、修正及刪除的不可變異動紀錄，亦用於相同請求安全重試。';

create function public.prevent_delivery_admin_mutation_change()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = '管理者外送異動紀錄不可修改或刪除';
end;
$$;
revoke all on function public.prevent_delivery_admin_mutation_change() from public, anon, authenticated;
grant execute on function public.prevent_delivery_admin_mutation_change() to service_role, delivery_admin_writer;
create trigger delivery_admin_mutations_no_update_delete
  before update or delete on public.delivery_admin_mutations
  for each row execute function public.prevent_delivery_admin_mutation_change();
create trigger delivery_admin_mutations_no_truncate
  before truncate on public.delivery_admin_mutations
  for each statement execute function public.prevent_delivery_admin_mutation_change();

-- The flag alone is insufficient: only the unloginable RPC owner role may
-- take this path. It cannot update the store, original photo, identifiers,
-- create retry metadata or created_at, and cannot revive deleted rows.
create or replace function public.enforce_delivery_record_immutability()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if to_jsonb(new) is distinct from to_jsonb(old) then
    if current_user <> 'delivery_admin_writer'
       or current_setting('app.delivery_admin_mutation', true) is distinct from 'allowed'
       or old.deleted_at is not null
       or new.version <> old.version + 1
       or new.updated_at <= old.updated_at
       or (to_jsonb(new) - array['unit_name','address','courier','delivered_at','amount',
         'distance_km','vehicle_type','version','updated_at','deleted_at'])
         is distinct from
         (to_jsonb(old) - array['unit_name','address','courier','delivered_at','amount',
         'distance_km','vehicle_type','version','updated_at','deleted_at']) then
      raise exception using errcode = '55000', message = '外送紀錄上傳後僅供查詢，不可編輯或刪除';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_delivery_record_immutability() from public, anon, authenticated;
grant execute on function public.enforce_delivery_record_immutability() to service_role, delivery_admin_writer;

-- A later administrator correction must not be hidden by an earlier receipt
-- timestamp. The public version still includes the one-time attachment.
create or replace function public.delivery_record_json(p_row public.delivery_records)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id', p_row.id, 'unit_name', p_row.unit_name, 'address', p_row.address,
    'courier', p_row.courier, 'delivered_at', p_row.delivered_at,
    'amount', p_row.amount, 'distance_km', p_row.distance_km,
    'vehicle_type', p_row.vehicle_type,
    'has_photo', p_row.photo_path is not null or attachment.record_id is not null,
    'version', p_row.version + case when attachment.record_id is not null then 1 else 0 end,
    'updated_at', greatest(p_row.updated_at, attachment.created_at)
  ) from (select 1) seed
    left join public.delivery_photo_attachments attachment
      on attachment.record_id = p_row.id and attachment.store_id = p_row.store_id;
$$;
revoke all on function public.delivery_record_json(public.delivery_records) from public, anon, authenticated;
grant execute on function public.delivery_record_json(public.delivery_records) to service_role, delivery_admin_writer;

create function public.admin_load_delivery_records(p_month text, p_store_id integer default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  start_at timestamptz;
  end_at timestamptz;
  result jsonb;
  count_rows bigint;
begin
  if p_store_id is not null and p_store_id not in (1, 2) then
    raise exception using errcode = '22023', message = '外送管理僅提供潮州店與木崎';
  end if;
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or p_month < '1900-01' then
    raise exception using errcode = '22023', message = '月份無效';
  end if;
  start_at := (p_month || '-01')::timestamp at time zone 'Asia/Taipei';
  end_at := (((p_month || '-01')::timestamp) + interval '1 month') at time zone 'Asia/Taipei';
  select count(*) into count_rows from public.delivery_records
    where deleted_at is null and store_id in (1, 2)
      and (p_store_id is null or store_id = p_store_id)
      and delivered_at >= start_at and delivered_at < end_at;
  if count_rows > 10000 then
    raise exception using errcode = '54000', message = '所選月份超過一萬筆，請縮小門市範圍後再查詢或匯出';
  end if;
  select jsonb_build_object(
    'records', coalesce(jsonb_agg(
      public.delivery_record_json(r) || jsonb_build_object('store_id', r.store_id, 'created_at', r.created_at)
      order by r.delivered_at desc, r.id), '[]'::jsonb),
    'total_count', count(*), 'total_amount', coalesce(sum(r.amount), 0),
    'total_distance_km', coalesce(sum(r.distance_km), 0)
  ) into result from public.delivery_records r
    where r.deleted_at is null and r.store_id in (1, 2)
      and (p_store_id is null or r.store_id = p_store_id)
      and r.delivered_at >= start_at and r.delivered_at < end_at;
  return result;
end;
$$;
revoke all on function public.admin_load_delivery_records(text, integer) from public, anon, authenticated;
grant execute on function public.admin_load_delivery_records(text, integer) to service_role;

create function public.admin_save_delivery_record(
  p_store_id integer, p_id uuid, p_request_id uuid, p_expected_version integer,
  p_record jsonb, p_photo_path text, p_request_fingerprint text, p_admin_session_version integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  existing public.delivery_records%rowtype;
  saved public.delivery_records%rowtype;
  previous public.delivery_admin_mutations%rowtype;
  has_existing boolean;
  delivered timestamptz;
  public_version integer;
  active_session_version integer;
  next_time timestamptz;
  operation text;
  request_payload jsonb;
  result jsonb;
begin
  select session_version into active_session_version from public.receipt_admin_config where id = 1;
  if p_admin_session_version is null or p_admin_session_version < 1
     or active_session_version is distinct from p_admin_session_version then
    raise exception using errcode = '42501', message = '管理者登入已失效，請重新登入';
  end if;
  if p_store_id is null or p_store_id not in (1, 2) or p_id is null or p_request_id is null
     or p_expected_version is null or p_expected_version < 0 or p_expected_version >= 2147483647
     or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = '管理者外送識別、門市或版本無效';
  end if;
  if p_record is null or jsonb_typeof(p_record) is distinct from 'object'
     or (p_record - array['unit_name','address','courier','delivered_at','amount','distance_km','vehicle_type']) <> '{}'::jsonb
     or not (p_record ?& array['unit_name','address','courier','delivered_at','amount','distance_km','vehicle_type'])
     or jsonb_typeof(p_record -> 'unit_name') is distinct from 'string'
     or jsonb_typeof(p_record -> 'address') is distinct from 'string'
     or jsonb_typeof(p_record -> 'courier') is distinct from 'string'
     or jsonb_typeof(p_record -> 'delivered_at') is distinct from 'string'
     or jsonb_typeof(p_record -> 'amount') is distinct from 'number'
     or jsonb_typeof(p_record -> 'distance_km') is distinct from 'number'
     or not (p_record -> 'vehicle_type' = 'null'::jsonb
       or (jsonb_typeof(p_record -> 'vehicle_type') = 'string' and p_record ->> 'vehicle_type' in ('personal','store')))
     or regexp_replace(p_record ->> 'address', '\s', '', 'g') = '屏東縣' then
    raise exception using errcode = '22023', message = '請完整填寫有效的外送資料與使用車輛';
  end if;
  begin
    delivered := (p_record ->> 'delivered_at')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = '22023', message = '外送日期時間無效';
  end;
  if p_photo_path is not null and (p_expected_version <> 0
     or not starts_with(p_photo_path, p_store_id::text || '/' || p_id::text || '/')
     or p_photo_path !~ '^[0-9]+/[0-9a-f-]{36}/[0-9a-f-]{36}-[0-9a-f]{64}\.(jpg|png|webp)$') then
    raise exception using errcode = '22023', message = '只有新增外送可以一併上傳照片，修改時保留原單據';
  end if;
  operation := case when p_expected_version = 0 then 'create' else 'update' end;
  request_payload := jsonb_build_object('id', p_id, 'store_id', p_store_id,
    'expected_version', p_expected_version, 'record', p_record,
    'photo_content', substr(split_part(p_photo_path, '/', 3), 38));
  -- A request lock prevents the same operation UUID being reused against two
  -- records; the record lock matches the store create/late-photo RPCs.
  perform pg_advisory_xact_lock(hashtextextended('delivery-admin:' || p_request_id::text, 273901));
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 273901));
  select * into previous from public.delivery_admin_mutations where request_id = p_request_id;
  if found then
    if previous.action = operation and previous.request_fingerprint = p_request_fingerprint
       and previous.request_payload = request_payload then
      return previous.result;
    end if;
    raise exception using errcode = '40001', message = '同一管理請求內容已變更，請重新讀取後再操作';
  end if;
  select * into existing from public.delivery_records where id = p_id;
  has_existing := found;
  if has_existing and existing.store_id <> p_store_id then
    raise exception using errcode = '40001', message = '此紀錄所屬門市不能更改，請重新讀取';
  end if;
  if has_existing and existing.deleted_at is not null then
    raise exception using errcode = 'P0002', message = '此外送紀錄已刪除';
  end if;
  if (p_expected_version = 0 and has_existing) or (p_expected_version > 0 and not has_existing) then
    raise exception using errcode = '40001', message = '外送紀錄已變更，請重新讀取後再操作';
  end if;
  if p_record -> 'vehicle_type' = 'null'::jsonb
     and (not has_existing or existing.vehicle_type is not null) then
    raise exception using errcode = '22023', message = '請選擇自用車或店用車';
  end if;
  if has_existing then
    public_version := existing.version + case when exists (
      select 1 from public.delivery_photo_attachments where record_id = p_id) then 1 else 0 end;
    if public_version <> p_expected_version or existing.version >= 2147483646 then
      raise exception using errcode = '40001', message = '外送紀錄已由其他畫面更新，請重新讀取';
    end if;
    next_time := greatest(clock_timestamp(), existing.updated_at + interval '1 microsecond');
    perform set_config('app.delivery_admin_mutation', 'allowed', true);
    update public.delivery_records set
      unit_name = p_record ->> 'unit_name', address = p_record ->> 'address', courier = p_record ->> 'courier',
      delivered_at = delivered, amount = (p_record ->> 'amount')::numeric,
      distance_km = (p_record ->> 'distance_km')::numeric, vehicle_type = p_record ->> 'vehicle_type',
      version = existing.version + 1, updated_at = next_time
      where id = p_id and store_id = p_store_id returning * into saved;
    perform set_config('app.delivery_admin_mutation', '', true);
  else
    insert into public.delivery_records
      (id,store_id,unit_name,address,courier,delivered_at,amount,distance_km,vehicle_type,
       photo_path,last_request_id,last_request_fingerprint)
      values (p_id,p_store_id,p_record ->> 'unit_name',p_record ->> 'address',p_record ->> 'courier',
        delivered,(p_record ->> 'amount')::numeric,(p_record ->> 'distance_km')::numeric,
        p_record ->> 'vehicle_type',p_photo_path,p_request_id,p_request_fingerprint)
      returning * into saved;
  end if;
  result := jsonb_build_object('record', public.delivery_record_json(saved)
    || jsonb_build_object('store_id',saved.store_id,'created_at',saved.created_at), 'photo_path',saved.photo_path);
  insert into public.delivery_admin_mutations
    (request_id,record_id,store_id,action,expected_version,admin_session_version,
      request_fingerprint,request_payload,before_record,after_record,result)
    values (p_request_id,p_id,p_store_id,operation,p_expected_version,p_admin_session_version,
      p_request_fingerprint,request_payload,case when has_existing then to_jsonb(existing) else null end,to_jsonb(saved),result);
  return result;
end;
$$;
alter function public.admin_save_delivery_record(integer,uuid,uuid,integer,jsonb,text,text,integer)
  owner to delivery_admin_writer;
revoke all on function public.admin_save_delivery_record(integer,uuid,uuid,integer,jsonb,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.admin_save_delivery_record(integer,uuid,uuid,integer,jsonb,text,text,integer) to service_role;

create function public.admin_delete_delivery_record(
  p_store_id integer, p_id uuid, p_request_id uuid, p_expected_version integer,
  p_request_fingerprint text, p_admin_session_version integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  existing public.delivery_records%rowtype;
  saved public.delivery_records%rowtype;
  previous public.delivery_admin_mutations%rowtype;
  public_version integer;
  active_session_version integer;
  next_time timestamptz;
  request_payload jsonb;
  result jsonb;
begin
  select session_version into active_session_version from public.receipt_admin_config where id = 1;
  if p_admin_session_version is null or p_admin_session_version < 1
     or active_session_version is distinct from p_admin_session_version then
    raise exception using errcode = '42501', message = '管理者登入已失效，請重新登入';
  end if;
  if p_store_id is null or p_store_id not in (1,2) or p_id is null or p_request_id is null
     or p_expected_version is null or p_expected_version < 1 or p_expected_version >= 2147483647
     or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = '刪除識別、門市或版本無效';
  end if;
  request_payload := jsonb_build_object('id',p_id,'store_id',p_store_id,'expected_version',p_expected_version);
  perform pg_advisory_xact_lock(hashtextextended('delivery-admin:' || p_request_id::text, 273901));
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 273901));
  select * into previous from public.delivery_admin_mutations where request_id = p_request_id;
  if found then
    if previous.action = 'delete' and previous.request_fingerprint = p_request_fingerprint
       and previous.request_payload = request_payload then
      return previous.result;
    end if;
    raise exception using errcode = '40001', message = '同一刪除請求內容已變更，請重新讀取';
  end if;
  select * into existing from public.delivery_records where id = p_id and store_id = p_store_id;
  if not found or existing.deleted_at is not null then
    raise exception using errcode = 'P0002', message = '找不到可刪除的外送紀錄';
  end if;
  public_version := existing.version + case when exists (
    select 1 from public.delivery_photo_attachments where record_id = p_id) then 1 else 0 end;
  if public_version <> p_expected_version or existing.version >= 2147483646 then
    raise exception using errcode = '40001', message = '外送紀錄已由其他畫面更新，請重新讀取';
  end if;
  next_time := greatest(clock_timestamp(),existing.updated_at + interval '1 microsecond');
  perform set_config('app.delivery_admin_mutation', 'allowed', true);
  update public.delivery_records set deleted_at=next_time, updated_at=next_time, version=existing.version+1
    where id=p_id and store_id=p_store_id returning * into saved;
  perform set_config('app.delivery_admin_mutation', '', true);
  result := jsonb_build_object('deleted',true,'id',p_id,'store_id',p_store_id,'version',public_version+1);
  insert into public.delivery_admin_mutations
    (request_id,record_id,store_id,action,expected_version,admin_session_version,
      request_fingerprint,request_payload,before_record,after_record,result)
    values (p_request_id,p_id,p_store_id,'delete',p_expected_version,p_admin_session_version,
      p_request_fingerprint,request_payload,to_jsonb(existing),to_jsonb(saved),result);
  return result;
end;
$$;
alter function public.admin_delete_delivery_record(integer,uuid,uuid,integer,text,integer)
  owner to delivery_admin_writer;
revoke all on function public.admin_delete_delivery_record(integer,uuid,uuid,integer,text,integer)
  from public, anon, authenticated;
grant execute on function public.admin_delete_delivery_record(integer,uuid,uuid,integer,text,integer) to service_role;

-- Only ownership setup needs CREATE. postgres retains the ability to maintain
-- these functions; the API/browser roles cannot SET ROLE to the writer.
revoke create on schema public from delivery_admin_writer;
