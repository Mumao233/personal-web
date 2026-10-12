import asyncio,json,sys
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[1]
BASE=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8766'
report={'started_at_utc':datetime.now(timezone.utc).isoformat(),'base_url':BASE,'external_network_blocked':True,'external_requests':[],'http_errors':[],'page_errors':[],'console_errors':[],'checks':[]}
def check(name,passed,**data):
    report['checks'].append({'check':name,'passed':bool(passed),**data});print(name,passed,flush=True);assert passed,name

async def audios(page):return await page.locator('audio').evaluate_all('(items)=>items.map(a=>({src:a.currentSrc||a.src,paused:a.paused,time:a.currentTime,error:a.error?.code??null}))')

async def main():
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(channel='chrome',headless=True)
        context=await browser.new_context(viewport={'width':1440,'height':960})
        async def route(r):
            if r.request.url.startswith((BASE+'/', 'blob:', 'data:')):await r.continue_()
            else:report['external_requests'].append(r.request.url);await r.abort()
        await context.route('**/*',route)
        page=await context.new_page()
        page.on('pageerror',lambda e:report['page_errors'].append(str(e)))
        page.on('console',lambda e:report['console_errors'].append(e.text) if e.type=='error' else None)
        page.on('response',lambda r:report['http_errors'].append({'url':r.url,'status':r.status}) if r.status>=400 else None)
        try:
            await page.goto(BASE+'/solar/?boot=0&view=atlas&body=earth',wait_until='domcontentloaded')
            await page.locator('.ocean-gateway').wait_for(timeout=45000)
            await page.locator('.music-toggle').first.click()
            await page.wait_for_timeout(800)
            check('solar music is disabled before leaving',await page.locator('.music-toggle').first.get_attribute('aria-pressed')=='false')
            await page.locator('.ocean-gateway').click()
            await page.wait_for_url(lambda u:urlsplit(u).path=='/',timeout=45000)
            await page.locator('.earth-music').wait_for(timeout=45000)
            await page.wait_for_timeout(1500)
            check('solar to Earth UI navigation preserves disabled music',await page.locator('.earth-music').get_attribute('aria-pressed')=='false' and all(x['paused'] for x in await audios(page)),url=page.url,audio=await audios(page))
            await page.locator('.solar-back').click()
            await page.wait_for_url('**/solar/**',timeout=45000)
            await page.locator('.ocean-gateway').wait_for(timeout=45000)
            check('Earth return button preserves disabled solar music',await page.locator('.music-toggle').first.get_attribute('aria-pressed')=='false',url=page.url,audio=await audios(page))
            await page.locator('.ocean-gateway').click()
            await page.wait_for_url(lambda u:urlsplit(u).path=='/',timeout=45000)
            await page.locator('.earth-music').wait_for(timeout=45000)
            await page.locator('.earth-music').click()
            await page.wait_for_timeout(2200)
            check('Earth local playback can be enabled',await page.locator('.earth-music').get_attribute('aria-pressed')=='true' and any(not x['paused'] and x['time']>0 for x in await audios(page)),audio=await audios(page))
            await page.locator('.solar-back').click()
            await page.wait_for_url('**/solar/**',timeout=45000)
            await page.locator('.ocean-gateway').wait_for(timeout=45000)
            await page.wait_for_timeout(2000)
            check('actual Earth to solar return preserves enabled playback',await page.locator('.music-toggle').first.get_attribute('aria-pressed')=='true' and any(not x['paused'] and x['src'].endswith('/01-sun-mother.mp3') and x['time']>0 for x in await audios(page)),url=page.url,audio=await audios(page))
            await page.screenshot(path=str(ROOT/'evidence/music-navigation-return.png'))
            check('navigation stays local with no HTTP or browser errors',not any(report[k] for k in ['external_requests','http_errors','page_errors','console_errors']))
            report['passed']=True
        except Exception as e:
            report['passed']=False;report['error']=str(e);print(str(e),flush=True)
            await page.screenshot(path=str(ROOT/'evidence/music-navigation-failure.png'))
        finally:
            report['finished_at_utc']=datetime.now(timezone.utc).isoformat()
            (ROOT/'evidence/music-navigation-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            await browser.close()
    if not report['passed']:raise SystemExit(1)

asyncio.run(main())
