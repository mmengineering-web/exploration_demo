// Edge Function: exp-admin-users
// Lets a SUPER ADMIN create / delete / reset-password for login accounts from the app.
// Why a function: creating or deleting Auth users needs the service-role key, which must NEVER be in the browser.
// The key lives only here (Supabase injects it as an environment variable), and every call first checks
// that the caller is a signed-in, active super admin of THIS site.
//
// Actions (POST JSON):
//   { action: "create", email, password, full_name, role }   -> creates Auth user (confirmed) + exp_profile row
//   { action: "delete", user_id }                            -> deletes the Auth user (profile is removed by cascade)
//   { action: "reset_password", user_id, password }          -> sets a new password
//
// Deploy: Supabase Dashboard > Edge Functions > Deploy a new function > "Via Editor", name it exactly
// `exp-admin-users`, paste this file, Deploy. Then open the function's settings and turn OFF "Verify JWT"
// (this function verifies the caller itself, and new-style API keys are not JWTs).
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // 1) Who is calling? (verify the user's own access token)
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Not signed in.' }, 401);
    const asCaller = createClient(url, anon, { auth: { persistSession: false } });
    const { data: u, error: uErr } = await asCaller.auth.getUser(token);
    if (uErr || !u?.user) return json({ error: 'Session invalid. Sign in again.' }, 401);
    const callerId = u.user.id;

    // 2) Is the caller an active super admin? (service client bypasses RLS, checks the real tables)
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: prof } = await admin.from('exp_profile').select('role,is_active').eq('user_id', callerId).maybeSingle();
    const { data: def } = prof
      ? await admin.from('exp_role_def').select('can_super,is_active').eq('role', prof.role).maybeSingle()
      : { data: null };
    if (!prof?.is_active || !def?.is_active || !def?.can_super) {
      return json({ error: 'Hanya super admin yang boleh mengelola akun user.' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? '');

    // ---- create ----
    if (action === 'create') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      const fullName = String(body.full_name ?? '').trim();
      const role = String(body.role ?? '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Email tidak valid.' }, 400);
      if (password.length < 10) return json({ error: 'Password minimal 10 karakter.' }, 400);
      if (!fullName) return json({ error: 'Nama wajib diisi.' }, 400);
      const { data: r } = await admin.from('exp_role_def').select('role,is_active').eq('role', role).maybeSingle();
      if (!r?.is_active) return json({ error: `Role "${role}" tidak ada atau tidak aktif.` }, 400);

      const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (cErr || !created?.user) return json({ error: cErr?.message ?? 'Gagal membuat akun.' }, 400);

      const { error: pErr } = await admin.from('exp_profile').insert({
        user_id: created.user.id, full_name: fullName, role, email, is_active: true,
      });
      if (pErr) {
        await admin.auth.admin.deleteUser(created.user.id);          // roll back: no half-created user
        return json({ error: pErr.message }, 400);
      }
      return json({ ok: true, user_id: created.user.id });
    }

    // ---- delete ----
    if (action === 'delete') {
      const target = String(body.user_id ?? '');
      if (!target) return json({ error: 'user_id wajib.' }, 400);
      if (target === callerId) return json({ error: 'Anda tidak bisa menghapus akun Anda sendiri.' }, 400);
      // profile first: the database guard refuses to delete the last active super admin
      const { error: dErr } = await admin.from('exp_profile').delete().eq('user_id', target);
      if (dErr) return json({ error: dErr.message }, 400);
      const { error: aErr } = await admin.auth.admin.deleteUser(target);
      if (aErr && !/not found/i.test(aErr.message)) return json({ error: aErr.message }, 400);
      return json({ ok: true });
    }

    // ---- reset password ----
    if (action === 'reset_password') {
      const target = String(body.user_id ?? '');
      const password = String(body.password ?? '');
      if (!target) return json({ error: 'user_id wajib.' }, 400);
      if (password.length < 10) return json({ error: 'Password minimal 10 karakter.' }, 400);
      const { error: rErr } = await admin.auth.admin.updateUserById(target, { password });
      if (rErr) return json({ error: rErr.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'Action tidak dikenal.' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
