-- Cron diario para el resumen operativo a agentes (Edge Function alertas-operativas).
--
-- Dispara net.http_post a la función todos los días a las 16:00 UTC = 9:00 AM
-- hora Chihuahua (UTC-7, sin horario de verano desde 2023). Si Chihuahua
-- volviera a observar DST, ajustar la hora del cron.
--
-- La función está desplegada con --no-verify-jwt, por eso el POST no lleva
-- Authorization (es invocable públicamente, igual que chat-alerts).
--
-- Idempotente: se puede correr varias veces sin duplicar el job.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'alertas-operativas-diario') then
    perform cron.unschedule('alertas-operativas-diario');
  end if;
end $$;

select cron.schedule(
  'alertas-operativas-diario',
  '0 16 * * *',  -- 16:00 UTC = 9:00 AM Chihuahua
  $$
  select net.http_post(
    url     := 'https://alisslhkyxblpvwzutcx.supabase.co/functions/v1/alertas-operativas',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000  -- la función tarda ~10-15s (trae y procesa MikroWisp); el default de 5s la cortaba
  );
  $$
);

-- Verificación:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'alertas-operativas-diario';
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname='alertas-operativas-diario') order by start_time desc limit 5;
