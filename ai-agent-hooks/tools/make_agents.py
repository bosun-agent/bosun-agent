#!/usr/bin/env python3
"""
초보자용·숙련자용 Agent 설정 만들기 (11/6)

왜 필요한가
  사용자가 "계획 먼저 보여 주기"를 원할 수도, 원하지 않을 수도 있다(11/6 시원 님).
  docker-agent는 폴더 하나에 설정 파일을 여러 개 두면 서버 하나로 같이 띄운다(serve api <폴더>).
  API 이름은 파일 이름이다 → /api/sessions/{id}/agent/beginner, /api/sessions/{id}/agent/expert
  WEB은 사용자 선택에 따라 주소만 바꿔 부르면 된다.

무엇이 다른가
  두 파일은 기준 설정(agent.yaml)과 권한·훅·도구·모델이 완전히 같다. 안내문(instruction)만 다르다.
  - expert.yaml  : 기준 설정 그대로(변경 요청은 바로 도구를 불러 승인 카드로 확인)
  - beginner.yaml: 변경 요청을 받으면 먼저 쉬운 말로 계획을 보여 주고, 사용자가 동의하면 실행(plan+apply)
  안전장치가 같으므로 사용자가 어느 쪽을 골라도 할 수 있는 일과 막히는 일은 같다.

사용
  python3 tools/make_agents.py <기준 agent.yaml> <출력 폴더>
  예: python3 tools/make_agents.py ../agent-run/agent.yaml ../agent-run/agents
  기준 설정을 고친 뒤에는 다시 실행해서 두 파일을 맞춘다.
"""
import os
import sys

DIRECT_RULE = ("      - 승인은 도구를 호출하면 시스템이 사용자에게 직접 묻는다. 사용자가 요청한 변경은 대화로 먼저 허락을 구하지 말고 바로 호출한다. "
               "여러 단계가 필요하면 단계마다 호출하면 각각 승인 질문이 나간다.\n")
PLAN_RULE = """      - [초보자용: 계획 먼저 보여 주기] 변경 요청(앱 만들기·고치기·켜기·끄기·컨테이너 시작·정지·재시작·삭제·이미지 받기·지금 백업)을 받으면,
        필요한 조회(환경, 스택·컨테이너 목록, 지금 Compose 등)만 먼저 하고 변경 도구는 아직 부르지 않는다.
        그다음 할 일을 쉬운 말로 번호를 붙여 계획으로 보여 준다. 무엇을 만들거나 바꾸는지, 쓸 이미지, 공개 포트(접속 주소),
        데이터를 남기는 볼륨, 자원(메모리·CPU. 적지 않으면 메모리 512MB·CPU 1개가 자동으로 들어간다), 승인 카드가 몇 번 뜨는지를 넣는다. 처음 보는 용어는 한 줄로 풀어 쓴다.
        끝에 "이대로 진행할까요? 바꾸고 싶은 부분이 있으면 말씀해 주세요."라고 묻고 그 턴을 끝낸다.
        사용자가 동의하면 계획대로 단계마다 도구를 호출한다(각각 승인 카드가 뜬다). 사용자가 고치면 계획을 다시 보여 준다.
        계획에 없는 변경은 하지 않는다. 조회만 하는 요청은 계획 없이 바로 실행한다. 할 수 없는 작업은 계획에 넣지 않고 바로 안내한다.
      - 승인은 도구를 호출하면 시스템이 사용자에게 직접 묻는다. 여러 단계가 필요하면 단계마다 호출하면 각각 승인 질문이 나간다.
"""
DESC = "    description: Docker/Portainer 운영 보조 AI Agent\n"


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    base, out = sys.argv[1], sys.argv[2]
    text = open(base, encoding="utf-8").read()
    for need in (DIRECT_RULE, DESC):
        if text.count(need) != 1:
            sys.exit(f"기준 설정에서 바꿀 줄을 찾지 못했습니다(안내문이 바뀌었으면 이 스크립트도 고치세요): {need.strip()[:40]}")
    head = "# 이 파일은 tools/make_agents.py가 기준 설정에서 만든다. 직접 고치지 말고 기준 설정을 고친 뒤 다시 만든다.\n"
    expert = head + "# 숙련자용: 변경 요청은 바로 도구를 불러 승인 카드로 확인한다(기준 설정과 같음).\n" + text.replace(
        DESC, "    description: Docker/Portainer 운영 보조 AI Agent (숙련자용 — 바로 실행, 승인 카드로 확인)\n")
    beginner = head + "# 초보자용: 변경 전에 쉬운 말로 계획을 보여 주고, 사용자가 동의하면 실행한다(plan+apply).\n" + text.replace(
        DIRECT_RULE, PLAN_RULE).replace(DESC, "    description: Docker/Portainer 운영 보조 AI Agent (초보자용 — 계획을 먼저 보여 줌)\n")
    os.makedirs(out, exist_ok=True)
    for name, body in (("beginner.yaml", beginner), ("expert.yaml", expert)):
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            f.write(body)
    print(f"만들었습니다: {out}/beginner.yaml, {out}/expert.yaml")


if __name__ == "__main__":
    main()
