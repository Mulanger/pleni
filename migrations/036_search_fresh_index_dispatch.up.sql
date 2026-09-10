-- New publications should not wait behind a five-clips-per-minute cron batch.
-- Keep the existing minute worker as the historical/rollback path. Dispatch
-- only when a fresh message is visible, never for an empty or claimed queue.
create function private.dispatch_search_fresh_index_v2() returns bigint
language plpgsql security definer set search_path='' as $fn$
declare endpoint text; secret text; request_id bigint;
begin
  if not exists(select 1 from private.search_system_state where singleton
    and provider_enabled and not provider_kill_switch) then return null; end if;
  if not exists(select 1 from pgmq.q_search_embeddings where vt<=now()) then return null; end if;
  select decrypted_secret into endpoint from vault.decrypted_secrets where name='search_embed_function_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name='search_embed_worker_secret';
  if nullif(endpoint,'') is null or nullif(secret,'') is null then return null; end if;
  select net.http_post(url:=endpoint,body:='{"limit":10}'::jsonb,
    headers:=jsonb_build_object('Content-Type','application/json','X-Search-Worker-Secret',secret),
    timeout_milliseconds:=60000) into request_id;
  return request_id;
end;
$fn$;
revoke all on function private.dispatch_search_fresh_index_v2() from public,anon,authenticated;
grant execute on function private.dispatch_search_fresh_index_v2() to service_role;
select cron.schedule('search-fresh-index-v2','15 seconds','select private.dispatch_search_fresh_index_v2();');
