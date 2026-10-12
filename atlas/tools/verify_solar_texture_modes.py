import asyncio,json,sys
from datetime import datetime,timezone
from pathlib import Path
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[1]
BASE=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8766'
REPORT={'started_at_utc':datetime.now(timezone.utc).isoformat(),'base_url':BASE,'external_network_blocked':True,'configuration_method':'Original application quality/device URL parameters; mobile viewport 390x844 with touch. No changes to rendering source or texture URLs.','cases':[]}
CASES=[('desktop-low',1440,960,'low','desktop','-512.'),('desktop-safe',1440,960,'safe','desktop','-512.'),('mobile-medium',390,844,'medium','phone','-1k.'),('desktop-high-earth',1440,960,'high','desktop','-4k.')]

async def main():
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(channel='chrome',headless=True)
        for name,width,height,quality,device,variant in CASES:
            result={'case':name,'viewport':{'width':width,'height':height},'quality_parameter':quality,'device_parameter':device,'expected_texture_variant':variant,'external_requests':[],'http_errors':[],'console_errors':[],'page_errors':[],'texture_responses':[]}
            REPORT['cases'].append(result)
            context=await browser.new_context(viewport={'width':width,'height':height},is_mobile=device=='phone',has_touch=device=='phone')
            async def route(r):
                if r.request.url.startswith((BASE+'/', 'blob:', 'data:')):await r.continue_()
                else:result['external_requests'].append(r.request.url);await r.abort()
            await context.route('**/*',route)
            page=await context.new_page()
            page.on('pageerror',lambda e:result['page_errors'].append(str(e)))
            page.on('console',lambda e:result['console_errors'].append(e.text) if e.type=='error' else None)
            def response(r):
                if r.status>=400:result['http_errors'].append({'url':r.url,'status':r.status})
                if '/planets/' in r.url or '/moons/' in r.url:result['texture_responses'].append({'url':r.url,'status':r.status,'content_type':r.headers.get('content-type'),'bytes':r.headers.get('content-length')})
            page.on('response',response)
            try:
                await page.goto(BASE+f'/solar/?boot=0&view=atlas&body=earth&debug=1&quality={quality}&device={device}',wait_until='domcontentloaded')
                await page.locator('canvas').first.wait_for(timeout=45000)
                await page.wait_for_timeout(8000)
                result['quality_state']=await page.evaluate('window.__atlasQuality?.()??null')
                result['variant_responses']=[r for r in result['texture_responses'] if variant in r['url']]
                result['page_view']=await page.evaluate('({width:innerWidth,height:innerHeight,touchPoints:navigator.maxTouchPoints,bodyWidth:document.body.scrollWidth,canvasBounds:Array.from(document.querySelectorAll("canvas")).map(c=>({width:c.width,height:c.height}))})')
                result['earth_details_visible']=await page.locator('.ocean-gateway').is_visible()
                result['passed']=bool(result['variant_responses']) and not any(result[k] for k in ['external_requests','http_errors','console_errors','page_errors']) and all(r['status']==200 and r['content_type'].startswith('image/') for r in result['texture_responses'])
                result['screenshot']='evidence/'+name+'.png'
                await page.screenshot(path=str(ROOT/result['screenshot']))
                print(name,result['passed'],'variant textures',len(result['variant_responses']),'errors',result['http_errors'],flush=True)
            except Exception as e:
                result['passed']=False;result['error']=str(e);print(name,str(e),flush=True)
            await context.close()
            (ROOT/'evidence/solar-texture-modes-validation.json').write_text(json.dumps(REPORT,ensure_ascii=False,indent=2),encoding='utf-8')
        await browser.close()
    REPORT['passed']=all(r['passed'] for r in REPORT['cases'])
    REPORT['finished_at_utc']=datetime.now(timezone.utc).isoformat()
    (ROOT/'evidence/solar-texture-modes-validation.json').write_text(json.dumps(REPORT,ensure_ascii=False,indent=2),encoding='utf-8')
    if not REPORT['passed']:raise SystemExit(1)

asyncio.run(main())
