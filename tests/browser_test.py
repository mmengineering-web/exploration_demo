import sys
from playwright.sync_api import sync_playwright
BASE = 'http://localhost:8766'
STUB = open('tests/stub_supabase.mjs').read(); DEXIE = open('tests/dexie.mjs').read()
fails = []
def check(name, cond, extra=''):
    print(('PASS ' if cond else 'FAIL ') + name + (' ' + str(extra) if extra and not cond else ''))
    if not cond: fails.append(name)

def new_page(p, **kw):
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1360, 'height': 900}, service_workers='block', **kw)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
    pg.route('**/supabase-js@2/+esm', lambda r: r.fulfill(body=STUB, content_type='application/javascript'))
    pg.route('**/dexie@4/+esm', lambda r: r.fulfill(body=DEXIE, content_type='application/javascript'))
    pg.route('https://cdn.jsdelivr.net/**', lambda r: r.abort() if 'dexie' not in r.request.url and 'supabase' not in r.request.url else r.fallback())
    return b, ctx, pg, errs

def login(pg, pw='good'):
    pg.goto(BASE + '/index.html'); pg.wait_for_selector('#lf')
    pg.fill('#l-email', 'geo@x'); pg.fill('#l-pw', pw); pg.click('#l-go')

with sync_playwright() as p:
    b, ctx, pg, errs = new_page(p)
    login(pg); pg.wait_for_selector('#nav button')
    tabs = pg.eval_on_selector_all('#nav button', 'bs => bs.map(b => b.dataset.t)')
    check('input tabs still present', all(t in tabs for t in ['progress', 'collars', 'hours', 'samples', 'import', 'map', 'report', 'list', 'admin']), tabs)
    check('dashboard tabs present', 'dash' in tabs, tabs)
    pg.click('#nav button[data-t=dash]'); pg.wait_for_selector('#view .ex-card'); pg.wait_for_selector('#view canvas')
    tk = pg.inner_text('#view .ex-take'); kp = pg.inner_text('#view .ex-kpis')
    check('take sentence has month to date', 'Month to date' in tk and 'm' in tk, tk)
    check('MTD meters 84', '84' in kp, kp[:150])
    check('live chip shows site', 'Live from WKM' in pg.inner_text('#view .dash-bar'))
    check('canvas sized', pg.eval_on_selector('#view canvas', 'c => c.width > 100'))
    check('five sections', pg.locator('#view .ex-sec').count() == 5)
    qs = pg.locator('#view .ex-sec', has_text='QAQC Geokimia'); qt = qs.inner_text()
    check('QAQC section labels', all(x in qt for x in ['QAQC Geokimia', 'Sampel terkirim', 'ROA belum diinput', 'Excel QAQC tertunda', 'Insertion rate QC', 'Blank gagal', 'CRM gagal', 'Duplikat gagal']), qt[:200])
    check('QAQC failed counts 1 / 1', 'Blank gagal\n1 / 1' in qt.replace('\n\n', '\n') or '1 / 1' in qt, qt[:400])
    check('QAQC has 3 charts', qs.locator('canvas').count() == 3, qs.locator('canvas').count())
    check('QAQC canvases sized', all(qs.locator('canvas').nth(i).evaluate('c => c.width > 100 && c.height > 100') for i in range(3)))
    check('rig table rows', pg.locator('#view .ex-table tbody tr').count() >= 2)
    qs.scroll_into_view_if_needed(); pg.screenshot(path='/tmp/m_dash.png', full_page=True)
    pg.evaluate("document.documentElement.dataset.theme='dark'"); pg.wait_for_timeout(200); pg.screenshot(path='/tmp/m_dash_dark.png', full_page=True); pg.evaluate("document.documentElement.dataset.theme='light'")
    pg.click('#period button[data-period=weekly]'); pg.wait_for_selector('#view canvas')
    check('weekly pressed', pg.get_attribute('#period button[data-period=weekly]', 'aria-pressed') == 'true')
    pg.select_option('#fProspect', 'N1'); pg.wait_for_selector('#view .ex-kpis'); check('prospect filter keeps page', pg.locator('#view .ex-sec').count() == 5)
    pg.click('#fReset'); check('reset clears prospect', pg.input_value('#fProspect') == '')
    # collar map (Leaflet is blocked in the test network, so the page must say so and still show the legend), exports
    mp = pg.locator('#view .ex-sec', has_text='Collar Map').inner_text()
    check('collar map legend by class', all(x in mp for x in ['Planned', 'EOH', 'COH', 'collars have coordinates']), mp[:200])
    pg.wait_for_function("document.querySelector('#g-map') && /needs internet|leaflet-container/i.test(document.querySelector('#g-map').innerHTML + document.querySelector('#g-map').className)", timeout=8000)
    check('collar map shows map or offline note', True)
    with pg.expect_download() as dl: pg.click('#d-xlsx')
    check('dashboard Excel downloads', dl.value.suggested_filename.endswith('.xlsx') and 'WKM' in dl.value.suggested_filename, dl.value.suggested_filename)
    with pg.expect_download(timeout=20000) as dl: pg.click('#d-pdf')
    check('dashboard PDF downloads', dl.value.suggested_filename.endswith('.pdf'), dl.value.suggested_filename)
    pg.wait_for_selector('#view canvas'); check('charts back after PDF export', pg.locator('#view canvas').count() >= 6, pg.locator('#view canvas').count())
    check('theme untouched by PDF export', pg.evaluate("document.documentElement.getAttribute('data-theme')") in (None, 'light'))
    # Data QC tab
    check('Data QC and RoA tabs present', 'qc' in tabs and 'roa' in tabs, tabs)
    pg.click('#nav button[data-t=qc]'); pg.wait_for_selector('#view .kpis'); pg.wait_for_selector('#view .qc-tbl')
    k = pg.inner_text('#view .kpis')
    check('QC KPIs shown', 'Critical issues' in k and 'QAQC checks failed' in k, k[:120])
    t = pg.inner_text('#view .qc-tbl')
    check('QC issues: interval beyond total depth', 'deeper than total depth' in t, t[:200])
    check('QC issues: blank above limit', 'Ni 0.06% in blank' in t, t[:300])
    check('QC issues: failing PD duplicate', 'Ni ARD' in t and 'limit 5%' in t, t[:400])
    check('QC issues: CRM fail', 'Z=3.5' in t or 'Z=3.4' in t, t[:400])
    pg.select_option('#f-sev', 'critical'); pg.wait_for_timeout(150)
    check('severity filter works', 'Warning' not in pg.inner_text('#view .qc-tbl tbody'))
    pg.click('#q-sub button[data-s=qaqc]'); pg.wait_for_selector('#view canvas')
    q = pg.inner_text('#view .grid')
    check('QAQC shows batch status fail', 'LAB/26-1' in q and 'Fail' in q, q[:200])
    check('QAQC has 4 charts', pg.locator('#view canvas').count() >= 4, pg.locator('#view canvas').count())
    pg.screenshot(path='/tmp/m_qaqc.png', full_page=True)
    pg.click('#q-sub button[data-s=thr]'); pg.wait_for_selector('#view .qc-tbl')
    check('thresholds explained', 'Blank: Ni maximum' in pg.inner_text('#view') and 'Z-score' in pg.inner_text('#view'))
    with pg.expect_download() as dl: pg.click('#q-xls')
    check('issues excel downloads', dl.value.suggested_filename.startswith('data_qc_WKM'), dl.value.suggested_filename)
    with pg.expect_download() as dl2: pg.click('#q-lab')
    check('lab analysis workbook downloads', dl2.value.suggested_filename.startswith('lab_analysis_WKM'), dl2.value.suggested_filename)
    # RoA tab (real lab PDF is only used when present on this machine)
    pg.click('#nav button[data-t=roa]'); pg.wait_for_selector('#roa-file', state='attached')
    import os
    pdf = '/mnt/user-data/uploads/8d43b642-TPB-DO-SAMP-071.pdf'
    if os.path.exists(pdf):
        pg.set_input_files('#roa-file', pdf); pg.wait_for_selector('#roa-go', timeout=60000)
        o = pg.inner_text('#roa-out')
        check('RoA parsed 132 primary + QC', '132 sampel utama' in o and '21 duplikat' in o and '6 CRM' in o and '7 blank' in o, o[:200])
        check('RoA warns about missing collars', 'has no collar' in o)
        pg.click('#roa-go'); pg.wait_for_selector('#roa-out .msg.ok', timeout=20000)
        check('RoA saved to the phone', 'disimpan' in pg.inner_text('#roa-out'))
        pg.set_input_files('#roa-file', pdf); pg.wait_for_selector('#roa-go', timeout=60000)
        check('RoA re-import is skipped', 'Simpan 0 baris' in pg.inner_text('#roa-out'), pg.inner_text('#roa-out')[:200])
    # input app still works next to it
    pg.click('#nav button[data-t=progress]'); pg.wait_for_selector('#view form, #view .card')
    check('Drilling Progress form opens', pg.locator('#view').inner_text().strip() != '')
    pg.click('#nav button[data-t=collars]'); pg.wait_for_timeout(300); check('Collar tab opens', pg.locator('#view').inner_text().strip() != '')
    pg.click('#nav button[data-t=map]'); pg.wait_for_timeout(300)
    # fast tab switching: a late dashboard result must not overwrite another tab
    pg.click('#nav button[data-t=dash]'); pg.click('#nav button[data-t=admin]'); pg.wait_for_timeout(600)
    check('late dashboard load does not overwrite the next tab', pg.locator('#view .dash').count() == 0)
    # mobile
    pg.set_viewport_size({'width': 390, 'height': 800}); pg.click('#b-more'); pg.click('.ui-overlay button[data-t=dash]'); pg.wait_for_selector('#view .dash .ex-card')
    w = pg.evaluate('[document.documentElement.scrollWidth, window.innerWidth, [...document.querySelectorAll("#view *")].filter(e => e.getBoundingClientRect().right > window.innerWidth + 2 && !e.closest(".tw")).slice(0,3).map(e => e.tagName+"."+e.className)]')
    check('mobile: dashboard has no horizontal overflow', w[0] <= w[1] + 2, w)
    pg.screenshot(path='/tmp/m_mobile.png')
    pg.set_viewport_size({'width': 1360, 'height': 900})
    # offline: tab explains itself, nothing crashes
    ctx.set_offline(True); pg.click('#nav button[data-t=dash]'); pg.wait_for_timeout(300)
    check('offline: dashboard says it needs internet', 'needs internet' in pg.inner_text('#view'), pg.inner_text('#view')[:120])
    ctx.set_offline(False)
    check('no JS errors', not errs, errs[:3]); b.close()

    # a table the user cannot read: clear error + retry, app alive
    b, ctx, pg, errs = new_page(p); pg.add_init_script('window.__failTable = "exp_weekly_plan"')
    login(pg); pg.wait_for_selector('#nav button'); pg.click('#nav button[data-t=dash]'); pg.wait_for_selector('#d-retry')
    check('load failure shows reason + retry', 'permission denied' in pg.inner_text('#view'))
    check('nav still usable after failure', pg.locator('#nav button').count() > 3); b.close()

    # All sites (explohub): tab hidden without HUB config, then shown with it; own login; site filter; no QAQC; sign out
    b, ctx, pg, errs = new_page(p); pg.goto(BASE + '/index.html'); login(pg); pg.wait_for_selector('#nav button')
    check('All sites tab hidden when HUB has no key', 'hubdash' not in pg.eval_on_selector_all('#nav button', 'bs => bs.map(b => b.dataset.t)')); b.close()
    cfg = open('js/config.js').read().replace("anon: '' };", "anon: 'test-anon' };")
    for member in (True, False):
        b, ctx, pg, errs = new_page(p)
        pg.route('**/js/config.js', lambda r: r.fulfill(body=cfg, content_type='application/javascript'))
        if not member: pg.add_init_script('window.__hubNoMember = true')
        login(pg); pg.wait_for_selector('#nav button')
        check('All sites tab shown with HUB key', 'hubdash' in pg.eval_on_selector_all('#nav button', 'bs => bs.map(b => b.dataset.t)'))
        pg.click('#nav button[data-t=hubdash]'); pg.wait_for_selector('#h-form')
        pg.fill('#h-email', 'geo@x'); pg.fill('#h-pw', 'bad'); pg.click('#h-go'); pg.wait_for_selector('#h-form .msg.err')
        check('hub login refuses a bad password', 'Invalid login' in pg.inner_text('#h-form'))
        pg.fill('#h-pw', 'good'); pg.click('#h-go')
        if not member:
            pg.wait_for_selector('#h-out'); check('hub non-member is told so', 'not an active dashboard member' in pg.inner_text('#view')); b.close(); continue
        pg.wait_for_selector('#view canvas'); txt = pg.inner_text('#view')
        check('hub shows all-sites title and chip', 'all sites' in txt and 'Explohub' in txt, txt[:120])
        check('hub has no QAQC section but has Site status', 'QAQC Geokimia' not in txt and 'Site status' in txt)
        check('hub site filter lists both sites', pg.eval_on_selector_all('#fSite option', 'o => o.map(x => x.value)') == ['', 'BM', 'WKM'])
        check('hub site status table', pg.locator('#g-status tbody tr').count() == 2 and 'Error' in pg.inner_text('#g-status'))
        pg.select_option('#fSite', 'BM'); pg.wait_for_selector('#view .ex-sec')
        check('hub Site filter narrows the collars', '1 of 1 collars have coordinates' in pg.inner_text('#g-maplegend'), pg.inner_text('#g-maplegend'))
        pg.select_option('#fSite', ''); check('hub all sites collars', '5 of 5 collars have coordinates' in pg.inner_text('#g-maplegend'), pg.inner_text('#g-maplegend'))
        with pg.expect_download() as dl: pg.click('#d-xlsx')
        check('hub Excel downloads', 'all-sites' in dl.value.suggested_filename)
        pg.click('#d-out'); pg.wait_for_selector('#h-form'); check('hub sign out returns to login', True)
        pg.click('#nav button[data-t=dash]'); pg.wait_for_selector('#view .ex-card'); check('site dashboard unaffected by hub sign out', 'Live from' in pg.inner_text('#view .dash-bar'))
        check('no JS errors (hub)', not errs, errs[:3]); b.close()

    # viewer: dashboard is the first tab, no input tabs
    b, ctx, pg, errs = new_page(p); pg.add_init_script('window.__role = "viewer"')
    login(pg); pg.wait_for_selector('#nav button')
    tabs = pg.eval_on_selector_all('#nav button', 'bs => bs.map(b => b.dataset.t)')
    check('viewer: no input forms', not any(t in tabs for t in ['progress', 'collars', 'hours', 'samples']), tabs)
    check('viewer lands on Dashboard', tabs[0] == 'dash' and pg.locator('#nav button.on').get_attribute('data-t') == 'dash', tabs)
    pg.wait_for_selector('#view .dash .ex-card'); b.close()

    # guest: no dashboard tabs
    b, ctx, pg, errs = new_page(p); pg.goto(BASE + '/index.html'); pg.wait_for_selector('#l-guest'); pg.click('#l-guest'); pg.wait_for_selector('#nav button')
    tabs = pg.eval_on_selector_all('#nav button', 'bs => bs.map(b => b.dataset.t)')
    check('guest has no dashboard tabs', 'dash' not in tabs, tabs); b.close()

print('\nFAILED:' if fails else '\nALL PASSED', fails); sys.exit(1 if fails else 0)
