import asyncio,json,re,sys
from datetime import datetime,timezone
from pathlib import Path
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'evidence/solar-music-validation.json'
report={'started_at_utc':datetime.now(timezone.utc).isoformat(),'external_network_blocked':True,'external_requests':[],'http_errors':[],'page_errors':[],'console_errors':[],'checks':[]}

async def state(page):
    return await page.locator('audio').evaluate_all('(items)=>items.map(a=>({src:a.currentSrc||a.src,time:a.currentTime,duration:Number.isFinite(a.duration)?a.duration:null,paused:a.paused,volume:a.volume,readyState:a.readyState,error:a.error?.code??null}))')

def add(name,passed,**data):
    report['checks'].append({'check':name,'passed':bool(passed),**data})
    print(name,passed,flush=True)
    OUT.parent.mkdir(parents=True,exist_ok=True);OUT.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    assert passed,name

async def main():
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(channel='chrome',headless=True)
        context=await browser.new_context(viewport={'width':1440,'height':960})
        async def route(r):
            if r.request.url.startswith(('http://127.0.0.1:8765/','blob:','data:')): await r.continue_()
            else: report['external_requests'].append(r.request.url);await r.abort()
        await context.route('**/*',route)
        page=await context.new_page()
        page.on('pageerror',lambda e:report['page_errors'].append(str(e)))
        page.on('console',lambda e:report['console_errors'].append(e.text) if e.type=='error' else None)
        page.on('response',lambda r:report['http_errors'].append({'url':r.url,'status':r.status}) if r.status>=400 else None)
        try:
            await page.goto('http://127.0.0.1:8765/solar/?boot=0',wait_until='domcontentloaded')
            await page.wait_for_timeout(6000)
            intro=page.get_by_role('button',name='进入图谱',exact=True)
            if await intro.is_visible(): await intro.press('Enter')
            await page.wait_for_timeout(3500)
            await page.get_by_role('button',name='背景音乐',exact=True).click()
            await page.locator('.hall__track').first.wait_for()
            add('14 local tracks displayed',await page.locator('.hall__track').count()==14,labels=await page.locator('.hall__track').all_text_contents())
            await page.locator('.hall__track').filter(has_text='Sun Mother').click()
            await page.wait_for_timeout(3000)
            one=await state(page);await page.wait_for_timeout(750);two=await state(page)
            a=next(x for x in two if not x['paused'] and x['volume']>0)
            add('complete local default song plays and advances',a['src'].endswith('/audio/music/01-sun-mother.mp3') and 216<a['duration']<217 and any(x['src']==a['src'] and x['time']<a['time'] for x in one),before=one,after=two)
            await page.locator('.hall__play').click();await page.wait_for_timeout(900)
            paused=await state(page);await page.wait_for_timeout(500);stable=await state(page)
            add('pause stops all playback',all(x['paused'] for x in stable) and all(abs(x['time']-y['time'])<0.03 for x,y in zip(paused,stable)),audio=stable)
            await page.get_by_role('button',name='下一首 ▶▶',exact=True).click();await page.wait_for_timeout(1000)
            paused_next=await state(page)
            add('next track changes selection while paused',await page.locator('.hall__now h3').inner_text()=='The Somnium' and all(x['paused'] for x in paused_next) and any(x['src'].endswith('/02-the-somnium.mp3') for x in paused_next),audio=paused_next)
            await page.get_by_role('button',name='◀◀ 上一首',exact=True).click();await page.wait_for_timeout(700)
            add('previous track changes selection while paused',await page.locator('.hall__now h3').inner_text()=='Sun Mother' and all(x['paused'] for x in await state(page)))
            await page.locator('.hall__play').click();await page.wait_for_timeout(1300)
            resumed=await state(page)
            add('resume plays the selected slot',any(not x['paused'] and x['src'].endswith('/01-sun-mother.mp3') and x['time']>0 for x in resumed),audio=resumed)
            await page.locator('.hall__play').click();await page.wait_for_timeout(800)
            await page.locator('.hall__track').filter(has_text='Ether').click();await page.wait_for_timeout(1800)
            selected=await state(page)
            add('selecting a track while paused starts that track',any(not x['paused'] and x['src'].endswith('/ether.mp3') and x['time']>0 for x in selected),audio=selected)
            seek=page.get_by_role('slider',name='播放进度',exact=True)
            await seek.press('Home')
            for _ in range(12): await seek.press('ArrowRight')
            await page.wait_for_timeout(400)
            seeked=await state(page)
            add('keyboard seeking moves actual audio position',any(not x['paused'] and x['src'].endswith('/ether.mp3') and x['time']>=12 for x in seeked),audio=seeked)
            await page.locator('.hall__track').filter(has_text='The Somnium').click()
            await page.locator('.hall__track').filter(has_text='Wither Away').click()
            await page.wait_for_timeout(3300)
            switched=await state(page)
            add('rapid switching leaves only the last chosen track playing',sum(not x['paused'] for x in switched)==1 and any(not x['paused'] and x['src'].endswith('/04-wither-away.mp3') for x in switched) and await page.locator('.hall__now h3').inner_text()=='Wither Away',audio=switched)
            await page.screenshot(path=str(ROOT/'evidence/solar-music-local.png'))
            # Each state is passed through the public handoff storage contract used by both apps.
            await page.locator('.hall__play').click();await page.wait_for_timeout(800)
            await page.evaluate("sessionStorage.setItem('atlas.music.handoff',JSON.stringify({enabled:false,at:Date.now()}))")
            await page.goto('http://127.0.0.1:8765/solar/?boot=0&return=ocean',wait_until='domcontentloaded')
            await page.wait_for_timeout(4500)
            toggles=await page.locator('.music-toggle').all_text_contents()
            add('return handoff preserves music off',bool(toggles) and all('关' in t or 'OFF' in t for t in toggles) and all(x['paused'] for x in await state(page)),toggles=toggles,audio=await state(page))
            await page.evaluate("sessionStorage.setItem('atlas.music.handoff',JSON.stringify({enabled:true,at:Date.now()}))")
            await page.goto('http://127.0.0.1:8765/solar/?boot=0&return=ocean',wait_until='domcontentloaded')
            await page.wait_for_timeout(4500)
            await page.locator('body').click(position={'x':20,'y':400})
            await page.wait_for_timeout(1500)
            toggles=await page.locator('.music-toggle').all_text_contents()
            add('return handoff preserves music on and local playback',bool(toggles) and all('开' in t or 'ON' in t for t in toggles) and any(not x['paused'] and x['src'].endswith('/01-sun-mother.mp3') for x in await state(page)),toggles=toggles,audio=await state(page))
            add('no external requests, failed HTTP responses or browser errors',not any(report[k] for k in ['external_requests','http_errors','page_errors','console_errors']))
            report['passed']=True
        except Exception as e:
            report['passed']=False;report['error']=str(e);print(str(e),flush=True)
            await page.screenshot(path=str(ROOT/'evidence/solar-music-failure.png'))
        finally:
            report['finished_at_utc']=datetime.now(timezone.utc).isoformat()
            OUT.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            await browser.close()
    if not report['passed']:raise SystemExit(1)

asyncio.run(main())
