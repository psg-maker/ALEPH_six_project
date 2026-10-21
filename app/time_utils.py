from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))


def now_in_seoul():
    # 기존 DB 형식에 맞춰 서울 시각을 시간대 표시 없이 저장한다.
    return datetime.now(KST).replace(tzinfo=None)


def today_in_seoul():
    return now_in_seoul().date()