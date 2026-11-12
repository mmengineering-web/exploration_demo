-- 0005: block duplicate / too-close collar coordinates (planned AND as-built). Safe to run twice.
-- Distance limit lives in exp_setting 'collar_min_dist_m' (metres, 0 = off). Editable in app: Pengaturan > Parameter.

insert into public.exp_setting (key, value) values ('collar_min_dist_m', '2') on conflict (key) do nothing;

-- great-circle distance in metres (haversine)
create or replace function public.exp_dist_m(lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric)
returns double precision language sql immutable as $$
  select 2 * 6371008.8 * asin(least(1, sqrt(
    power(sin(radians((lat2 - lat1)::float8) / 2), 2) +
    cos(radians(lat1::float8)) * cos(radians(lat2::float8)) * power(sin(radians((lon2 - lon1)::float8) / 2), 2))))
$$;

create or replace function public.exp_guard_collar_dup()
returns trigger language plpgsql as $$
declare
  lim double precision;
  o record; d double precision; a text; b text;
begin
  if new.is_deleted then return new; end if;
  select (value #>> '{}')::double precision into lim from public.exp_setting where key = 'collar_min_dist_m';
  lim := coalesce(lim, 2);
  if lim <= 0 then return new; end if;
  if tg_op = 'UPDATE'
     and new.planned_lat is not distinct from old.planned_lat and new.planned_lon is not distinct from old.planned_lon
     and new.asbuilt_lat is not distinct from old.asbuilt_lat and new.asbuilt_lon is not distinct from old.asbuilt_lon
     and old.is_deleted = false then
    return new;   -- coordinates unchanged: don't re-check (keeps old data editable)
  end if;
  for o in select * from public.exp_collar where id <> new.id and not is_deleted loop
    for a in select unnest(array['planned','asbuilt']) loop
      for b in select unnest(array['planned','asbuilt']) loop
        declare la numeric; lo numeric; lb numeric; lq numeric;
        begin
          la := case a when 'planned' then new.planned_lat else new.asbuilt_lat end;
          lo := case a when 'planned' then new.planned_lon else new.asbuilt_lon end;
          lb := case b when 'planned' then o.planned_lat else o.asbuilt_lat end;
          lq := case b when 'planned' then o.planned_lon else o.asbuilt_lon end;
          if la is not null and lo is not null and lb is not null and lq is not null then
            d := public.exp_dist_m(la, lo, lb, lq);
            if d < lim then
              raise exception 'Koordinat % terlalu dekat (% m) dengan koordinat % lubang % (batas % m).',
                a, round(d::numeric, 1), b, o.hole_id, lim using errcode = '23505';
            end if;
          end if;
        end;
      end loop;
    end loop;
  end loop;
  return new;
end $$;

drop trigger if exists trg_exp_collar_dup on public.exp_collar;
create trigger trg_exp_collar_dup before insert or update on public.exp_collar
  for each row execute function public.exp_guard_collar_dup();
