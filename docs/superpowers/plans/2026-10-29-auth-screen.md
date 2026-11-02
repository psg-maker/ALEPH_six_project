# 로그인·회원가입 화면 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 사용자가 직접 작성하는 학습 흐름을 유지하고, 요청받은 부분만 대신 수정한다.

**Goal:** 비로그인 사용자는 로그인·회원가입 전환 화면을 보고, 세션 인증 후 자신의 앱 화면에 진입한다.

**Architecture:** FastAPI의 HTML 경로와 기존 JSON 인증 API를 구분한다. Jinja2 템플릿과 일반 JavaScript로 한 화면의 모드를 전환하며 기존 HttpOnly 세션 쿠키를 사용한다. HTML은 303 이동, 자료 API는 기존 JSON 401 동작을 유지한다.

**Tech Stack:** FastAPI, Jinja2, JavaScript, CSS, 기존 SQLAlchemy 세션 인증, unittest 및 기존 Node DOM 테스트 방식.

**Spec:** `docs/superpowers/specs/2026-10-29-auth-screen-design.md` (사용자 승인 완료)

## Global Constraints

- 로그인·회원가입은 한 화면에서 전환한다. 기본은 로그인이다.
- 회원가입 성공 시 로그인 모드로 돌아가 아이디를 채우고 비밀번호는 비운다. 자동 로그인은 하지 않는다.
- 기존 인증·자료 API의 권한 검사를 유지한다. 새 인증 라이브러리를 추가하지 않는다.
- 비밀번호·세션 토큰은 localStorage나 로그에 저장하지 않는다.
- 운영 DB·배포는 변경하지 않는다. commit·push는 별도 진행한다.
- 처음에는 HTML 폼부터 사용자가 직접 작성하고, 경로·이벤트·화면 연결을 순차적으로 설명한다.

## Review Focus

- 만료·폐기·잘못된 쿠키: HTML은 로그인으로 이동하고 API는 JSON 401을 유지해야 한다. Task 1 테스트에 포함한다.
- DB 오류: 인증 실패로 뭉뚱그려 리다이렉트하지 않는다. Task 1에서 401만 처리하는지 검사한다.
- 회원가입·로그인 모드 전환과 연속 클릭: 비밀번호를 비우고 요청을 중복 전송하지 않는다. Task 2 DOM 검사에 포함한다.
- 네트워크 오류·로그아웃 실패: 성공으로 표시하지 않고 오류를 전달한다. Task 2·3 DOM 검사에 포함한다.
- 다른 화면 스크립트의 401: 개인정보를 오류 메시지나 저장소로 복사하지 않고 로그인으로 이동한다. Task 3에서 확인한다.

### Task 1: 로그인 폼과 HTML 진입 경로

**Files:** Create `app/templates/login.html`, `app/static/auth.css`, `app/static/auth.js`, `tests/test_auth_pages.py`; modify `app/main.py`, `tests/test_today_ui.py`.

**Interfaces:** `/login`은 인증 폼을 렌더링하고, `/`는 세션 인증 후 기존 템플릿을 렌더링한다. 기존 `get_current_user(request, db)`를 재사용해 401만 HTML 리다이렉트로 변환한다. 폼 ID는 `auth-form`, 입력 ID는 `auth-username`, `auth-password`, 오류 ID는 `auth-error`다.

- [ ] 사용자와 로그인 폼의 HTML 뼈대를 작성한다. 이 단계에서는 경로·로그인 요청은 아직 연결하지 않는다.
- [ ] `tests/test_auth_pages.py`에 방문자의 `/` → 303 `/login`, `/login` → 200 및 폼 표시, 정상 쿠키의 `/` → 200, `/login` → 303 `/`, 만료·폐기 쿠키의 `/` → 303, `/plans` → JSON 401 검사를 준비한다. 임시 DB와 실제 세션 검사 사용.
- [ ] `./venv/Scripts/python.exe -m unittest tests.test_auth_pages -v`로 경로 미구현 실패를 확인한다.
- [ ] `app/main.py`에 `RedirectResponse`와 `/login` 경로를 연결한다. HTML 경로에서 `get_current_user`의 HTTPException 중 401만 처리한다. 다른 오류는 다시 발생시킨다. 인증 HTML에 `Cache-Control: no-store`를 적용한다.
- [ ] `auth.js`에서 폼 submit을 처리해 `POST /auth/login`으로 JSON을 보내고 성공 후 `/`로 이동한다. 에러는 textContent로 표시하고 pending 동안 입력·버튼을 잠근다.
- [ ] 기존 `planner.css`와 조화되는 `auth.css`로 폼 폭·모바일·포커스·레이블·오류를 정리한다.
- [ ] 위 경로 테스트를 통과시키고 기존 전체 Python 테스트를 실행한다.

### Task 2: 같은 화면에서 회원가입 모드 전환

**Files:** Modify `app/templates/login.html`, `app/static/auth.js`, `app/static/auth.css`; create `tests/test_auth_dom.cjs` using the repository's existing DOM test conventions.

**Interfaces:** `login`/`register` 모드에서 같은 `auth-form`을 사용한다. `POST /auth/register` 성공 후 아이디 유지·비밀번호 삭제·로그인 모드 전환, 로그인 요청 자동 실행 없음.

- [ ] DOM 테스트에 로그인 성공 이동, 로그인 오류, 가입 성공 후 모드 전환, 모드 전환 시 비밀번호 삭제, 중복 클릭 방지, 통신 오류 후 재시도 가능 조건을 작성한다.
- [ ] `node tests/test_auth_dom.cjs`로 미구현 동작 실패를 확인한다.
- [ ] 로그인·회원가입 전환 버튼과 문구·autocomplete(`current-password`/`new-password`)를 연결한다. 서버 정책 15~128자 안내를 표시한다.
- [ ] DOM 테스트와 Python 인증 테스트를 실행하고 브라우저에서 가입·로그인 흐름을 확인한다. 실제 계정 비밀번호는 테스트 파일에 넣지 않는다.

### Task 3: 앱의 계정 표시·로그아웃·세션 만료 처리

**Files:** Modify `app/templates/index.html`, `app/static/planner.js`, `app/static/notes.js`, `app/static/review.js`, `app/static/insights.js`, `app/static/planner.css`; add `app/static/session.js` if shared 401 handling is needed. Extend the auth page/DOM tests.

**Interfaces:** 서버가 `index.html`에 인증된 `account`를 전달한다. 로그아웃 버튼은 `POST /auth/logout` 성공 후 `/login`으로 이동하며, 자료 API 401 처리도 `/login`으로 이동한다.

- [ ] 사용자명이 이스케이프되어 출력되고 기존 공개 접근 안내가 제거·교체되는 테스트를 작성한다.
- [ ] 로그아웃 성공 시 이동, 실패 시 오류·화면 유지, 자료 API 401 발생 시 이동에 대한 DOM 검사를 작성하고 미구현 실패를 확인한다.
- [ ] 계정 표시와 로그아웃을 연결한다. 여러 데이터 스크립트에서 같은 401 처리 함수를 사용하도록 작은 공통 인터페이스를 정의한다.
- [ ] 원본 DB를 변경하지 않는 테스트 환경에서 전체 Python·관련 DOM 테스트를 실행하고, 브라우저에서 로그인·새로고침·로그아웃·비로그인 접근을 확인한다.
- [ ] `README_v2.md`, `WORK_LOG_v2.md`에 최종 동작과 실제 검증 범위를 기록한다. 완료 후 사용자와 커밋 시점을 정한다.
