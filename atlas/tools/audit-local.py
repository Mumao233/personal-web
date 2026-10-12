"""Audit saved files and resolvable static references; no network requests."""
import hashlib, json, re
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT=Path(__file__).resolve().parents[1]
result={'files':0,'bytes':0,'invalid_json':[],'disguised_html':[],'bad_magic':[],
        'missing_references':[],'checked_references':0,'manifest':[]}
for p in sorted(ROOT.rglob('*')):
    if not p.is_file() or '__pycache__' in p.parts or p.suffix=='.pyc':continue
    rel=p.relative_to(ROOT).as_posix()
    if rel.startswith(('evidence/','tools/')) or rel in ['crawl-report.json','README.md','test_server.py','server.py','start.bat','start.ps1']:continue
    b=p.read_bytes();result['files']+=1;result['bytes']+=len(b)
    result['manifest'].append({'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
    if p.suffix not in ['.html'] and b.lstrip().lower().startswith((b'<!doctype',b'<html')):result['disguised_html'].append(rel)
    if p.suffix=='.json':
        try:json.loads(b)
        except Exception as e:result['invalid_json'].append({'file':rel,'error':str(e)})
    magic={'.jpg':b'\xff\xd8', '.png':b'\x89PNG', '.woff':b'wOFF', '.woff2':b'wOF2', '.wasm':b'\0asm', '.glb':b'glTF'}
    if p.suffix in magic and not b.startswith(magic[p.suffix]):result['bad_magic'].append(rel)
    if p.suffix in ['.html','.css','.js']:
        s=b.decode('utf-8',errors='replace');refs=[]
        if p.suffix=='.html':refs+=re.findall(r'(?:src|href)=["\']([^"\']+)["\']',s)
        if p.suffix=='.css':refs+=re.findall(r'url\(\s*["\']?([^\s)"\']+)',s)
        if p.suffix=='.js':refs+=re.findall(r'(?:from|import)\s*(?:\(\s*)?["\'](\.{1,2}/[^"\']+\.js)["\']',s)
        for ref in refs:
            u=urlsplit(ref)
            if u.scheme or u.netloc or not u.path:continue
            target=(ROOT/u.path.lstrip('/') if u.path.startswith('/') else p.parent/u.path).resolve()
            result['checked_references']+=1
            if not target.is_file():result['missing_references'].append({'file':rel,'ref':ref})
result['passed']=not any(result[k] for k in ['invalid_json','disguised_html','bad_magic','missing_references'])
out=ROOT/'evidence/asset-integrity.json';out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k!='manifest'},ensure_ascii=False,indent=2))
raise SystemExit(0 if result['passed'] else 1)
