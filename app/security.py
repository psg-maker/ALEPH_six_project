import secrets
import hashlib
from pwdlib import PasswordHash


# 권장 설정으로 비밀번호 해시 도구를 준비한다.
password_hasher = PasswordHash.recommended()

# 없는 아이디로 로그인해도 비밀번호 검사 작업을 수행하기 위한 시험용 해시
DUMMY_PASSWORD_HASH = password_hasher.hash(secrets.token_urlsafe(32))


# 가입할 때: 비밀번호를 해시로 바꾼다.
def hash_password(password: str) -> str:
    return password_hasher.hash(password)


# 로그인할 때: 입력한 비밀번호가 저장된 해시와 맞는지 검사한다.
def verify_password(password: str, stored_hash: str) -> bool:
    return password_hasher.verify(password, stored_hash)

# 로그인 성공 시 브라우저에 전달할 무작위 세션 값
def generate_session_token() -> str:
    return secrets.token_urlsafe(32)


# DB에 저장할 세션 해시: 64자리 16진수 문자열
def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()