#!/usr/bin/env python3
"""Validate this documentation package only; no game code or game tests run."""
from pathlib import Path
from collections import Counter, defaultdict, deque
import json,re,hashlib,sys
ROOT=Path(__file__).resolve().parents[1]
errors=[]; checks={}; link_count=0
reqs=json.loads((ROOT/'00-overview/requirements.json').read_text())
tasks=json.loads((ROOT/'03-execution/tasks.json').read_text())
req_ids=[r['id'] for r in reqs]; task_ids=[t['id'] for t in tasks]
for label,ids in [('requirement',req_ids),('task',task_ids)]:
    for id,n in Counter(ids).items():
        if n>1:errors.append(f'Duplicate {label}: {id}')
checks['需求ID唯一']=len(req_ids);checks['任务ID唯一']=len(task_ids)
known=set(task_ids);rk=set(req_ids);used=set();indegree={k:0 for k in known};adj=defaultdict(list)
for t in tasks:
    for f in ['id','title','status','authorization','milestone','requirements','dependencies','design','owner_role','assignee','modules','inputs','outputs','steps','acceptance_tests','evidence_status']:
        if f not in t or (f!='dependencies' and not t[f]):errors.append(f'{t.get("id")}: missing {f}')
    if t['status']!='planned' or t['evidence_status']!='not_run' or t['authorization']!='pending_development_approval':errors.append(f'{t["id"]}: non-planned or misleading state')
    if len(t['steps'])<3 or len(t['acceptance_tests'])<3:errors.append(f'{t["id"]}: insufficient execution detail')
    if not (ROOT/'03-execution/tasks'/f'{t["id"]}.md').is_file():errors.append(f'{t["id"]}: missing brief')
    for r in t['requirements']:
        if r not in rk:errors.append(f'{t["id"]}: unknown requirement {r}')
        used.add(r)
    for d in t['dependencies']:
        if d not in known:errors.append(f'{t["id"]}: unknown dependency {d}')
        else:indegree[t['id']]+=1;adj[d].append(t['id'])
queue=deque(sorted(k for k,v in indegree.items() if v==0));order=[]
while queue:
    k=queue.popleft();order.append(k)
    for n in sorted(adj[k]):
        indegree[n]-=1
        if not indegree[n]:queue.append(n)
if len(order)!=len(tasks):errors.append('Dependency cycle: '+','.join(k for k,v in indegree.items() if v))
if rk-used:errors.append('Uncovered requirements: '+str(rk-used))
checks['全部需求被执行任务覆盖']=len(used);checks['无环任务拓扑排序']=len(order)
checks['全部任务planned/验收not_run']=len(tasks)

def anchors(p):
    txt=p.read_text(encoding='utf-8');a=set(re.findall(r'<a\s+id="([^"]+)"',txt));counts={}
    for h in re.findall(r'^#{1,6}\s+(.+)$',txt,re.M):
        slug=re.sub(r'[^\w\-\s]','',h.lower()).strip().replace(' ','-')
        n=counts.get(slug,0);counts[slug]=n+1;a.add(slug+(f'-{n}' if n else ''))
    return a
cache={}
def check_link(src,target):
    global link_count
    if target.startswith(('http:','https:','mailto:','data:')):return
    if target.startswith('<'):target=target[1:-1]
    if ' "' in target:target=target.split(' "',1)[0]
    path,_,fragment=target.partition('#');dst=(src.parent/path).resolve() if path else src.resolve()
    link_count+=1
    if not dst.is_relative_to(ROOT):errors.append(f'Outside package: {src.relative_to(ROOT)} -> {target}');return
    if not dst.exists():errors.append(f'Broken link: {src.relative_to(ROOT)} -> {target}');return
    if fragment and dst.suffix=='.md':
        cache.setdefault(dst,anchors(dst))
        if fragment not in cache[dst]:errors.append(f'Broken anchor: {src.relative_to(ROOT)} -> {target}')
for p in ROOT.rglob('*.md'):
    for target in re.findall(r'(?<!!)\[[^\]]+\]\(([^)]+)\)',p.read_text(encoding='utf-8')):check_link(p,target)
for t in tasks:
    for path in t['design']:check_link(ROOT/'README.md',path)
for r in reqs:check_link(ROOT/'README.md',r['source'])
checks['相对文档链接与锚点有效']=link_count
source=(ROOT/'source/game-design.md').read_text()
if len(re.findall(r'<a id="s\d\d"></a>',source))!=27:errors.append('Source section count mismatch')
raw=re.sub(r'<a id="s\d\d"></a>\n','',source).encode()
expected='f3a5478f7e3183dd9372b5d11811aced3f5dd6da6fb8f2cf07f59de38880b4d8'
if hashlib.sha256(raw).hexdigest()!=expected:errors.append('Frozen source hash mismatch')
checks['冻结原始源逐字节还原SHA一致']=expected
code=[str(p.relative_to(ROOT)) for p in ROOT.rglob('*') if p.suffix in ('.ts','.tsx','.js','.jsx','.html')]
if code:errors.append('Unexpected game implementation files: '+str(code))
checks['游戏实现文件数量']=len(code)
report=['# 文档包校验报告','','日期：2026-10-01','',f'结果：{"FAILED" if errors else "PASSED"}（仅文档结构校验）','',f'Markdown文档：{len(list(ROOT.rglob("*.md")))}；需求：{len(reqs)}；任务：{len(tasks)}','']
report += [f'- {k}：{v}' for k,v in checks.items()]
report += ['','## 任务可拓扑排序','',', '.join(order),'','## 当前游戏执行状态','','游戏未实现、未构建、未部署；所有游戏验收not_run。通过本校验不代表游戏性能、战斗、存档或中英翻译已完成。','']
if errors:report+=['## 错误','']+['- '+e for e in errors]
else:report+=['未发现缺失相对链接、重复ID、依赖环、无覆盖需求或误报完成状态。']
(ROOT/'validation/report.md').write_text('\n'.join(report)+'\n',encoding='utf-8')
print(json.dumps(dict(result='FAILED' if errors else 'PASSED',checks=checks,errors=errors),ensure_ascii=False,indent=2))
sys.exit(bool(errors))
