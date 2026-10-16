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
```

8765 포트의 테스트 서버는 메모리 DB만 사용하며 종료하면 데이터가 사라집니다.
폼 제출·중복 제출·완료/되돌리기·오류 표시·검색·계획 생성·새 페이지 조회를 확인합니다.
네이티브 dialog는 테스트에서 모사합니다. 실제 브라우저의 시각적 배치, 모바일 레이아웃,
키보드 초점과 대화상자 동작은 별도의 브라우저 확인이 필요합니다.

실제 앱은 다음 명령으로 실행합니다. 이 서버에서는 입력한 데이터가 개인 DB에 저장됩니다.

```powershell
.\venv\Scripts\python.exe -m uvicorn app.main:app --reload
```
