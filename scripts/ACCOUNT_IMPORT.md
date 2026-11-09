# 로컬 계정과 기록을 기존 Neon DB로 추가

프로젝트 루트의 터미널에서 실행합니다. 실제 대상은 Vercel의 `DATABASE_URL`과 같은 Neon 브랜치·DB인지 확인합니다.

```powershell
./venv/Scripts/python.exe -B -m scripts.import_account_to_neon --username qkrtjdrms
./venv/Scripts/python.exe -B -m scripts.import_account_to_neon --username qkrtjdrms --apply
```

첫 명령은 로컬 조회만 합니다. 두 번째 명령은 `NEON_DATABASE_URL`이 없으면 Neon 연결 URL을 숨김 입력으로 받습니다. Neon의 Connect에서 복사한 `postgresql://...` URL만 붙여넣습니다. `psql` 명령 전체를 붙여넣지 않습니다. 비밀번호·연결 URL·해시를 채팅이나 Git에 올리지 않습니다.

실행 중 앱의 기록 작성을 멈춥니다. 스크립트는 대상의 쓰기를 잠그고 현재 모델과 컬럼, 메모 고유 조건, 사용자 외래키를 검사합니다. 로컬 전체와 Neon 앱 테이블 전체를 각각 `backups/account-import-*.db`로 저장·검증한 뒤 선택한 계정과 그 계정 소유 기록만 추가합니다. 이 백업은 앱 자료의 SQLite 복사본이며 PostgreSQL 전체 구조·권한·시퀀스를 복원하는 덤프는 아닙니다. 백업에는 비밀번호 해시와 세션 해시가 포함되므로 공유하지 않습니다.

기존 Neon 자료는 변경하지 않습니다. 새 ID를 발급하고 내부 관계를 다시 연결합니다. 기존 Neon에 같은 내용이 있어도 자동 병합하지 않습니다. 이전에 남아 있던 소유자 없는 자료는 그대로 남으며 새 계정에 자동 연결하지 않습니다. 로컬 로그인 세션은 옮기지 않습니다. 같은 아이디가 이미 있으면 덮어쓰지 않고 중단합니다.

추가한 값·기존 값·전체 건수를 비교한 후 한 트랜잭션으로 커밋합니다. PostgreSQL 시퀀스 값은 롤백되어도 증가할 수 있으며 기록 삭제를 뜻하지 않습니다. 네트워크가 커밋 순간 끊기면 성공 여부가 불확실할 수 있으므로 오류 후 대상 `users`의 아이디 존재 여부를 확인합니다. 같은 아이디가 있으면 무작정 삭제하거나 재실행하지 않습니다.

성공 후 로그인 버전이 배포된 Vercel 앱에서 기존 아이디·비밀번호로 로그인하고 계획·메모·실행 기록을 확인합니다. 이 명령은 Git push나 Vercel 배포를 수행하지 않습니다.
