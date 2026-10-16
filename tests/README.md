# 오늘 화면 검증

개인 `planner.db`를 수정하지 않는 테스트입니다.

## 화면 응답과 API

프로젝트 루트에서 실행합니다.

```powershell
.\venv\Scripts\python.exe -B -m unittest discover -s tests -v
node --check app/static/planner.js
```

## DOM 이벤트와 실제 API 연결

테스트 도구는 화면의 의존성이 아닙니다. 제품 화면에는 프론트엔드 라이브러리가 없습니다.

```powershell
npm.cmd install --prefix work/ui-test-tools --no-save --package-lock=false jsdom
.\venv\Scripts\python.exe -B -m tests.ui_preview
```

두 번째 터미널에서 실행합니다.

```powershell
node tests/test_today_dom.cjs
node tests/test_task_delete_dom.cjs
node tests/test_task_edit_dom.cjs
node tests/test_execution_dom.cjs
node tests/test_task_link_dom.cjs
node tests/test_insights_dom.cjs
node tests/test_review_dom.cjs
node tests/test_daily_note_dom.cjs
node tests/test_plan_edit_dom.cjs
```

계획 수정 테스트는 기존 값 표시, 취소, 저장 실패 후 초안 보존과 재시도, 중복 제출 방지, 수정 전 이력, ID·상태·연결된 할 일 보존과 추가 모드 복원을 확인합니다.

일일 메모 테스트는 날짜별 저장·수정, 날짜 전환 시 초안 보존, 중복 제출 방지, 실패 후 재시도, 빈 문자열 저장, 조회 실패 시 편집 잠금을 확인합니다. 초안은 페이지를 닫거나 새로고침하면 사라집니다.

8765 포트의 테스트 서버는 메모리 DB만 사용하며 종료하면 데이터가 사라집니다.
폼 제출·중복 제출·완료/되돌리기·오류 표시·검색·계획 생성·새 페이지 조회를 확인합니다.
네이티브 dialog는 테스트에서 모사합니다. 실제 브라우저의 시각적 배치, 모바일 레이아웃,
키보드 초점과 대화상자 동작은 별도의 브라우저 확인이 필요합니다.

삭제 테스트는 취소/서버 오류/확인 후 성공/중복 클릭 방지/연결 기록 삭제/다른 기록 보존과
집계 갱신을 확인합니다. confirm은 테스트에서 응답을 모사합니다.
테스트 서버는 단일 메모리 DB 연결을 공유하므로 HTTP 요청을 순서대로 처리합니다.
이는 실제 앱 서버의 동시 처리 설정을 변경하지 않습니다.

수정 테스트는 기존 값 채우기·취소·PUT 저장·중복 제출 방지·오류 시 초안 유지와
Plan/완료 상태/완료 시각/연결 기록 보존 및 추가 모드 복귀를 검증합니다.

실행 기록 테스트는 Task별 이력, 분 단위 직접 입력(시각 차이 자동 계산 없음), 메모/막힌 이유,
0분/미입력 구분, 중복 제출 방지, 오류 시 초안 유지, 입력 오류 거부, 실제 시간 집계 갱신,
미완료/완료 Task의 원본·완료 시각 보존을 확인합니다.

자료 링크 테스트는 Task별 추가 폼, 취소·중복 제출 방지, URL 검사, 표시 이름의 안전한 렌더링,
새 탭 속성, 실패 시 초안 유지·재시도, 여러 링크 저장 및 Task/실행 기록 불변을 확인합니다.

돌아보기 테스트는 Plan별 집계 카드/완료율, 전체·완료·지연·막힘 숫자의 Task 근거 목록,
막힘 중복 제거/이유 표시, 실행 이력 열기, 예상·실제·차이의 근거 합계 일치,
빈 Plan, 집계/근거 조회 실패·재시도, 기존 화면 복귀를 검증합니다.

회고 테스트는 미작성/저장/저장 실패 시 초안 유지, 개선점 필수 검사, 다음 계획의 설명
미리보기·취소·생성 실패·재시도·중복 제출 방지, 원본 Plan 보존, 다음 Plan 연결 유지와
연결된 계획으로 이동해 반영된 설명을 확인하는 흐름을 검증합니다.

실제 앱은 다음 명령으로 실행합니다. 이 서버에서는 입력한 데이터가 개인 DB에 저장됩니다.

```powershell
.\venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

