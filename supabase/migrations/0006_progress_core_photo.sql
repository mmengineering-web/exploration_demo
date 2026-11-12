-- 0006: core photo per drilled interval (F1). Photo file is named <HOLE_ID>_<from>_<to>.jpg, stored at core/<name>.jpg
-- in the existing private bucket 'exp-photos'. Safe to run twice.
alter table public.exp_drill_progress add column if not exists photo_path text;
