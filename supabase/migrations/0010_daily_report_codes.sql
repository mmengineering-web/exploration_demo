-- 0010: codes used by the daily drilling report (run per site after 0008; safe to run twice).
-- Adds layers TS (Topsoil) and TRN (Transisi) and rig activities Time Trip / Break / Setting.
-- Existing codes and labels are never changed: rename "Moving/Setup" etc. in Pengaturan > Daftar kode if the site wants other words.
insert into public.exp_code_list (list_code, code, label, sort_order, meta, description) values
  ('layer','TS','Topsoil',5,'{}','Tanah pucuk / topsoil'),
  ('layer','TRN','Transisi',25,'{}','Zona transisi antara limonit dan saprolit'),
  ('activity','TIME_TRIP','Time Trip',50,'{}','Waktu trip rod / peralatan'),
  ('activity','BREAK','Break',60,'{}','Istirahat crew'),
  ('activity','SETTING','Setting',70,'{}','Setting / setup rig di titik')
on conflict (list_code, code) do nothing;
