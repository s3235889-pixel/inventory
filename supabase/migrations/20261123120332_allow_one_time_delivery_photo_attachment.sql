-- Allow one late receipt photo only when the immutable original has no photo.
-- Existing rows, their versions/request metadata, and UPDATE/DELETE/TRUNCATE
-- permissions are unchanged. Browser roles still cannot access delivery data.
create table public.delivery_photo_attachments (
  record_id uuid primary key references public.delivery_records(id),
  store_id integer not null check (store_id in (1, 2)),
  request_id uuid not null,
  base_version integer not null check (base_version > 0 and base_version < 2147483647),
  photo_hash text not null check (photo_hash ~ '^[0-9a-f]{64}$'),
  photo_path text not null check (
    starts_with(photo_path, store_id::text || '/' || record_id::text || '/')
    and photo_path ~ '^[0-9]+/[0-9a-f-]{36}/[0-9a-f-]{36}-[0-9a-f]{64}\.(jpg|png|webp)$'
    and photo_path ~ ('-' || photo_hash || '\.(jpg|png|webp)$')),
  created_at timestamptz not null default clock_timestamp() check (isfinite(created_at))
);
alter table public.delivery_photo_attachments enable row level security;
revoke all on public.delivery_photo_attachments from public, anon, authenticated, service_role;
grant select, insert on public.delivery_photo_attachments to service_role;
comment on table public.delivery_photo_attachments is '原紀錄無照片時可補傳一次的不可變附件；只由驗證門市的 delivery-api 存取。';

create function public.guard_delivery_photo_attachment_insert()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  parent public.delivery_records%rowtype;
begin
  -- Match the original save RPC lock without requiring UPDATE/FOR UPDATE.
  perform pg_advisory_xact_lock(hashtextextended(new.record_id::text, 273901));
  select * into parent from public.delivery_records where id = new.record_id;
  if not found or parent.deleted_at is not null then
    raise exception using errcode = 'P0002', message = '找不到可補傳單據的外送紀錄';
  end if;
  if parent.store_id <> new.store_id then
    raise exception using errcode = '42501', message = '沒有權限補傳此紀錄的單據';
  end if;
  if parent.photo_path is not null then
    raise exception using errcode = '55000', message = '此紀錄已有單據照片，不能更換或移除';
  end if;
  if parent.version <> new.base_version then
    raise exception using errcode = '40001', message = '紀錄版本已變更，請重新載入';
  end if;
  new.created_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.guard_delivery_photo_attachment_insert() from public, anon, authenticated;
grant execute on function public.guard_delivery_photo_attachment_insert() to service_role;
create trigger delivery_photo_attachments_guard_insert
  before insert on public.delivery_photo_attachments
  for each row execute function public.guard_delivery_photo_attachment_insert();

create function public.prevent_delivery_photo_attachment_change()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = '單據照片補傳後不能更換或移除';
end;
$$;
revoke all on function public.prevent_delivery_photo_attachment_change() from public, anon, authenticated;
grant execute on function public.prevent_delivery_photo_attachment_change() to service_role;
create trigger delivery_photo_attachments_no_update_delete
  before update or delete on public.delivery_photo_attachments
  for each row execute function public.prevent_delivery_photo_attachment_change();
create trigger delivery_photo_attachments_no_truncate
  before truncate on public.delivery_photo_attachments
  for each statement execute function public.prevent_delivery_photo_attachment_change();

-- Overlay the attachment in all record responses, including original save
-- exact retries. The original row/version/last_request_* remain byte-for-byte
-- unchanged; the public version advances once when its attachment is added.
create or replace function public.delivery_record_json(p_row public.delivery_records)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'id', p_row.id, 'unit_name', p_row.unit_name, 'address', p_row.address,
    'courier', p_row.courier, 'delivered_at', p_row.delivered_at,
    'amount', p_row.amount, 'distance_km', p_row.distance_km,
    'has_photo', p_row.photo_path is not null or attachment.record_id is not null,
    'version', p_row.version + case when attachment.record_id is not null then 1 else 0 end,
    'updated_at', coalesce(attachment.created_at, p_row.updated_at)
  ) from (select 1) seed
    left join public.delivery_photo_attachments attachment
      on attachment.record_id = p_row.id and attachment.store_id = p_row.store_id;
$$;
revoke all on function public.delivery_record_json(public.delivery_records) from public, anon, authenticated;
grant execute on function public.delivery_record_json(public.delivery_records) to service_role;

create function public.delivery_record_photo_path(p_store_id integer, p_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  path text;
begin
  if p_store_id is null or p_store_id not in (1, 2) then
    raise exception using errcode = '42501', message = '外送記錄僅限潮州店與木崎使用';
  end if;
  if p_id is null then raise exception using errcode = '22023', message = '紀錄識別無效'; end if;
  select coalesce(original.photo_path, attachment.photo_path) into path
    from public.delivery_records original
    left join public.delivery_photo_attachments attachment
      on attachment.record_id = original.id and attachment.store_id = original.store_id
    where original.id = p_id and original.store_id = p_store_id and original.deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = '找不到此外送紀錄'; end if;
  return jsonb_build_object('photo_path', path);
end;
$$;
revoke all on function public.delivery_record_photo_path(integer, uuid) from public, anon, authenticated;
grant execute on function public.delivery_record_photo_path(integer, uuid) to service_role;

create function public.attach_delivery_record_photo(
  p_store_id integer, p_id uuid, p_request_id uuid, p_expected_version integer,
  p_photo_hash text, p_photo_path text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  parent public.delivery_records%rowtype;
  attachment public.delivery_photo_attachments%rowtype;
begin
  if p_store_id is null or p_store_id not in (1, 2) then
    raise exception using errcode = '42501', message = '外送記錄僅限潮州店與木崎使用';
  end if;
  if p_id is null or p_request_id is null or p_expected_version is null or p_expected_version < 1
     or p_expected_version >= 2147483647 or p_photo_hash is null or p_photo_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = '補傳識別、版本或照片內容無效';
  end if;
  if p_photo_path is not null and (
      not starts_with(p_photo_path, p_store_id::text || '/' || p_id::text || '/')
      or p_photo_path !~ '^[0-9]+/[0-9a-f-]{36}/[0-9a-f-]{36}-[0-9a-f]{64}\.(jpg|png|webp)$'
      or p_photo_path !~ ('-' || p_photo_hash || '\.(jpg|png|webp)$')) then
    raise exception using errcode = '22023', message = '單據照片路徑無效';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 273901));
  select * into parent from public.delivery_records
    where id = p_id and store_id = p_store_id and deleted_at is null;
  if not found then raise exception using errcode = 'P0002', message = '找不到可補傳單據的外送紀錄'; end if;
  if parent.photo_path is not null then
    raise exception using errcode = '55000', message = '此紀錄已有單據照片，不能更換或移除';
  end if;
  select * into attachment from public.delivery_photo_attachments where record_id = p_id;
  if found then
    -- Confirm an exact retry before the one-photo lock, including a retry whose
    -- successful response was lost. A new object UUID is safe only for the same
    -- content/format; the API cleans exclusively its own redundant attempt.
    if attachment.store_id = p_store_id and attachment.request_id = p_request_id
       and attachment.base_version = p_expected_version and attachment.photo_hash = p_photo_hash
       and (p_photo_path is null or substr(split_part(attachment.photo_path, '/', 3), 38)
         = substr(split_part(p_photo_path, '/', 3), 38)) then
      return jsonb_build_object('record', public.delivery_record_json(parent),
        'photo_path', attachment.photo_path, 'ready_for_upload', false);
    end if;
    raise exception using errcode = '55000', message = '此紀錄的單據已補傳，不能更換或移除';
  end if;
  if parent.version <> p_expected_version then
    raise exception using errcode = '40001', message = '紀錄版本已變更，請重新載入';
  end if;
  -- Null path is a read-only preflight. It prevents known locked/not-found/
  -- cross-store cases from uploading an object, but reserves nothing. The
  -- post-upload call rechecks everything atomically under the same lock.
  if p_photo_path is null then
    return jsonb_build_object('record', public.delivery_record_json(parent),
      'photo_path', null, 'ready_for_upload', true);
  end if;
  insert into public.delivery_photo_attachments
    (record_id, store_id, request_id, base_version, photo_hash, photo_path)
    values (p_id, p_store_id, p_request_id, p_expected_version, p_photo_hash, p_photo_path)
    returning * into attachment;
  return jsonb_build_object('record', public.delivery_record_json(parent),
    'photo_path', attachment.photo_path, 'ready_for_upload', false);
end;
$$;
revoke all on function public.attach_delivery_record_photo(integer, uuid, uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.attach_delivery_record_photo(integer, uuid, uuid, integer, text, text) to service_role;
