-- After upload, delivery records and their photos are for queries only.
-- This changes permissions and guards without modifying any existing rows.
-- New inserts and exact retries of their initial upload remain supported.
revoke update, delete, truncate on public.delivery_records from public, anon, authenticated, service_role;
grant select, insert on public.delivery_records to service_role;

-- Keep the existing RPC signature for cached clients, but perform no lookup,
-- mutation, or photo cleanup. There is no application administrator exception.
create or replace function public.delete_delivery_record(p_store_id integer, p_id uuid, p_expected_version integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if p_store_id is null or p_store_id not in (1, 2) then
    raise exception using errcode = '42501', message = '外送記錄僅限潮州店與木崎使用';
  end if;
  if p_id is null or p_expected_version is null or p_expected_version < 1 or p_expected_version >= 2147483647 then
    raise exception using errcode = '22023', message = '刪除識別或版本無效';
  end if;
  raise exception using errcode = '55000', message = '外送紀錄上傳後僅供查詢，不可編輯或刪除';
end;
$$;
revoke all on function public.delete_delivery_record(integer, uuid, integer) from public, anon, authenticated;
grant execute on function public.delete_delivery_record(integer, uuid, integer) to service_role;

-- The existing UPDATE trigger now also rejects changes to deletion metadata.
-- A true no-op does not change data; all actual modifications are forbidden.
create or replace function public.enforce_delivery_record_immutability()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception using errcode = '55000', message = '外送紀錄上傳後僅供查詢，不可編輯或刪除';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_delivery_record_immutability() from public, anon, authenticated;
grant execute on function public.enforce_delivery_record_immutability() to service_role;

-- Guard hard deletion independently of privileges. TRUNCATE does not run row
-- triggers, so it has its own statement trigger as well.
create function public.prevent_delivery_record_deletion()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = '外送紀錄上傳後僅供查詢，不可編輯或刪除';
end;
$$;
revoke all on function public.prevent_delivery_record_deletion() from public, anon, authenticated;
grant execute on function public.prevent_delivery_record_deletion() to service_role;
create trigger delivery_records_no_delete
  before delete on public.delivery_records
  for each row execute function public.prevent_delivery_record_deletion();
create trigger delivery_records_no_truncate
  before truncate on public.delivery_records
  for each statement execute function public.prevent_delivery_record_deletion();
