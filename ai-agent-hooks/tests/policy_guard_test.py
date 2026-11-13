import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_portainer  # noqa: E402,F401 — 11/1: 정책 훅이 컨테이너를 Portainer에 물어 ID로 고정하므로 가짜 Portainer를 띄운다
H = sys.argv[1]
def run(method, path, query=None, body=None, **kw):
    ti = {"environment_id": 3, "method": method, "path": path}
    if query is not None: ti["query_params"] = query
    if body is not None: ti["body"] = body
    ti.update(kw)
    r = subprocess.run([sys.executable, "-X", "utf8", H], input=json.dumps({"tool_name": "docker_proxy", "tool_input": ti}), capture_output=True, text=True)
    o = json.loads(r.stdout)
    return "block" if o.get("decision") == "block" else ("rewrite" if o else "pass"), o
cases = [
 # (기대, method, path, query, body)
 ("block","POST","/containers/web/pause",None,None),   # 11/1: 경로를 컨테이너 전체 ID로 고정  # 11/6: 정책표 3절 DENY라 이제 거부
 ("block","POST","/containers/web/unpause",None,None),  # 11/6: 정책표 3절 DENY라 이제 거부
 ("block","POST","/containers/web/kill",None,None),
 ("block","POST","/containers/web/kill",{"signal":"SIGKILL"},None),
 ("block","POST","/containers/web/pause",None,{"x":1}),
 ("block","GET","/images/search",{"term":"nginx"},None),  # 11/6: 정책표 3절 DENY라 이제 거부
 ("block","GET","/images/search",{"term":"nginx","limit":"500"},None),  # 11/6: 정책표 3절 DENY라 이제 거부
 ("block","GET","/images/search",{"term":"nginx","filters":"{}"},None),
 ("block","GET","/images/search",{"term":"nginx; rm"},None),
 ("block","POST","/networks/create",None,{"Name":"app-net"}),  # 11/6: 정책표 3절 DENY라 이제 거부
 ("block","POST","/networks/create",None,{"name":"app-net","driver":"bridge","Labels":{"a":"b"},"Internal":True}),  # 11/6: 정책표 3절 DENY라 이제 거부
 ("block","POST","/networks/create",None,{"Name":"lan","Driver":"macvlan","Options":{"parent":"eth0"}}),
 ("block","POST","/networks/create",None,{"Name":"lan","Driver":"macvlan"}),
 ("block","POST","/networks/create",None,{"Name":"x","IPAM":{"Config":[{"Subnet":"10.0.0.0/8"}]}}),
 ("block","POST","/networks/create",None,{"Name":"host"}),
 ("block","POST","/networks/create",None,None),
 ("block","POST","/networks/app-net/connect",None,{"Container":"web","EndpointConfig":{"Aliases":["db"]}}),  # 11/6: 정책표 3절 DENY라 이제 거부
 ("block","POST","/networks/app-net/connect",None,{"Container":"web","EndpointConfig":{"IPAMConfig":{"IPv4Address":"10.0.0.5"}}}),
 ("block","POST","/networks/app-net/connect",None,{"Container":"portainer"}),
 ("block","POST","/networks/app-net/disconnect",None,{"Container":"web"}),  # 11/6: 정책표 3절 DENY라 이제 거부
 ("block","POST","/networks/app-net/disconnect",None,{"Container":"web","Force":True}),
 ("block","POST","/networks/app-net/connect",{"x":"1"},{"Container":"web"}),
 ("block","POST","/volumes/create",None,{"Name":"v","DriverOpts":{"type":"none","o":"bind","device":"/"}}),
 ("block","POST","/volumes/create",None,{"Name":"v"}),
 # 기존 동작 회귀
 ("pass","GET","/containers/json",None,None),
 ("block","POST","/containers/web/exec",None,{"Cmd":["ls"]}),
 ("block","POST","/containers/create",{"name":"web"},{"Image":"nginx:alpine"}),  # 10/31: 스택으로 변경
 ("block","POST","/containers/create",None,{"Image":"alpine","HostConfig":{"Privileged":True}}),
 ("block","POST","/images/create",{"fromSrc":"http://x"},None),
 ("block","DELETE","/containers/web",{"force":"true"},None),
 ("block","GET","/containers/web/arch%69ve",None,None),
 ("block","POST","/containers/web/update",None,{"Devices":[]}),
]
fail=0
for exp,m,p,q,b in cases:
    got,o=run(m,p,q,b)
    ok = got==exp
    fail += not ok
    print("OK " if ok else "XX ", exp, got, m, p, json.dumps(q,ensure_ascii=False) if q else "", json.dumps(b,ensure_ascii=False) if b else "", ("" if ok else json.dumps(o,ensure_ascii=False)[:200]))
print(f"{len(cases)-fail}/{len(cases)} 통과")
