-- 0011: map class "Progress" is removed. COH = continuation of hole (drilling). Run per site; safe to run twice.
update public.exp_code_list set meta = meta || '{"map_class":"coh"}'::jsonb
 where list_code = 'collar_status' and meta->>'map_class' = 'progress';
-- abandoned used to show as COH; an abandoned hole is finished, so show it as EOH (change in Pengaturan if the site wants otherwise)
update public.exp_code_list set meta = meta || '{"map_class":"eoh"}'::jsonb
 where list_code = 'collar_status' and code = 'abandoned' and meta->>'map_class' = 'coh';
