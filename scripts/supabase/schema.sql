-- Run once in the intended Supabase project's SQL editor. No anon/authenticated access.
-- Latest state only: one row per owner's device; fields keep individual observation times.
create table if not exists public.phone_presence_devices (
  owner_id text not null check (owner_id ~ '^[0-9]{5,20}$'),
  device_id text not null check (device_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_received_at timestamptz,
  primary key (owner_id, device_id)
);
create table if not exists public.phone_presence_state (
  owner_id text not null,
  device_id text not null,
  fields jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (owner_id, device_id),
  foreign key (owner_id, device_id) references public.phone_presence_devices(owner_id, device_id) on delete cascade
);
alter table public.phone_presence_devices enable row level security;
alter table public.phone_presence_state enable row level security;
revoke all on public.phone_presence_devices, public.phone_presence_state from anon, authenticated;
grant select, update on public.phone_presence_devices to service_role;
grant select, insert, update on public.phone_presence_state to service_role;

-- Only the Edge Function's server credential can invoke this RPC. Tokens bind owner/device;
-- IDs from the phone are never trusted. The device lock serializes partial changes atomically.
create or replace function public.phone_presence_ingest(p_token_hash text, p_state jsonb, p_observed_at timestamptz)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_device public.phone_presence_devices%rowtype;
  v_fields jsonb;
  v_field text;
  v_value jsonb;
  v_ttl integer;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_state) is distinct from 'object'
    or p_state = '{}'::jsonb or p_observed_at is null
    or p_observed_at > now() + interval '5 minutes' or p_observed_at < now() - interval '24 hours' then
    raise invalid_parameter_value using message = 'invalid phone state';
  end if;
  for v_field, v_value in select key, value from jsonb_each(p_state) loop
    if (v_field in ('charging', 'screenOn') and jsonb_typeof(v_value) = 'boolean')
      or (v_field = 'batteryLevel' and jsonb_typeof(v_value) = 'number'
        and (v_value::text)::numeric between 0 and 100 and (v_value::text)::numeric = trunc((v_value::text)::numeric))
      or (v_field = 'network' and v_value in ('"wifi"'::jsonb, '"mobile"'::jsonb, '"offline"'::jsonb))
      or (v_field = 'routine' and v_value in ('"home"'::jsonb, '"sleep"'::jsonb, '"wakeup"'::jsonb)) then
      continue;
    end if;
    raise invalid_parameter_value using message = 'invalid phone state field';
  end loop;
  select * into v_device from public.phone_presence_devices
    where token_hash = p_token_hash and enabled for update;
  if not found then return false; end if;
  select fields into v_fields from public.phone_presence_state
    where owner_id = v_device.owner_id and device_id = v_device.device_id;
  v_fields := coalesce(v_fields, '{}'::jsonb);
  for v_field, v_value in select key, value from jsonb_each(p_state) loop
    if v_fields ? v_field and (v_fields -> v_field ->> 'observedAt')::timestamptz > p_observed_at then
      continue;
    end if;
    v_ttl := case v_field when 'screenOn' then 300000 when 'routine' then 14400000 else 1800000 end;
    v_fields := v_fields || jsonb_build_object(v_field, jsonb_build_object(
      'value', v_value, 'observedAt', to_char(p_observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'ttlMs', v_ttl));
  end loop;
  insert into public.phone_presence_state(owner_id, device_id, fields, updated_at)
    values(v_device.owner_id, v_device.device_id, v_fields, p_observed_at)
    on conflict(owner_id, device_id) do update set fields = excluded.fields,
      updated_at = greatest(phone_presence_state.updated_at, excluded.updated_at);
  update public.phone_presence_devices set last_received_at = now()
    where owner_id = v_device.owner_id and device_id = v_device.device_id;
  return true;
end;
$$;
revoke all on function public.phone_presence_ingest(text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.phone_presence_ingest(text, jsonb, timestamptz) to service_role;

-- Revoke a phone: update public.phone_presence_devices set enabled = false
--   where owner_id = '123456789' and device_id = 'my-phone';
-- Erase its temporary state: delete from public.phone_presence_state
--   where owner_id = '123456789' and device_id = 'my-phone';
