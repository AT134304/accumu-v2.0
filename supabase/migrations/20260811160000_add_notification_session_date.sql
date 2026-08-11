-- Accumu v2 — 기간제 프로그램 상태형 알림이 진행일마다 뜨게 한다 (ADR 0018)
--
-- [배경] 케빈이 지목한 사용성 문제 2번: "알림이 프로그램당 딱 1번만 뜸". 20260808140000이 만든
--   notifications_once_per_program_idx는 (recipient_id, program_id, type)로 좁혀서, 기간제
--   프로그램은 8일이든 20일이든 그 프로그램 전체에서 딱 1번만 upcoming/upcoming_admin/exit_due가
--   떴다 — 20260808140000/20260810140000이 이미 "알려진 열화"로 문서화해 뒀던 바로 그 제약이다.
--
-- [고친 방법 — session_date 컬럼 + 4열 unique] notifications에 session_date(nullable) 컬럼을 더하고,
--   unique 인덱스를 (recipient_id, program_id, type, coalesce(session_date, sentinel))로 넓힌다.
--   - stale은 여전히 session_date를 안 채운다 — "프로그램 전체가 지났다"는 하루짜리 사실이 아니라
--     계속 NULL(=sentinel 고정값)로 수렴해 예전처럼 프로그램당 1번만 뜬다.
--   - upcoming/upcoming_admin/exit_due는 그 알림이 가리키는 구체적인 날짜를 채운다. 기간제는
--     진행일마다 날짜가 다르므로 자연히 진행일 수만큼 각각 뜬다. 단일 일자는 날짜가 하나뿐이라
--     예전과 똑같이 1번만 뜬다(session_date를 채워도 값 자체가 하나뿐이라 결과가 안 바뀐다).
-- [왜 NULL을 그냥 두지 않고 coalesce로 고정하나] unique 제약에서 NULL은 서로 다른 값으로 취급된다
--   (NULL ≠ NULL). session_date를 그냥 nullable로만 두면 stale처럼 NULL을 쓰는 타입은 매번 새 NULL이
--   "다른 값"이 되어 중복 방지가 조용히 깨진다. coalesce(session_date, 고정 날짜)로 NULL을 하나의
--   값으로 묶어야 예전 동작(프로그램당 1번)이 그대로 보존된다.
--
-- [실행 순서] 아무 때나(20260810140000 이후 — sync_my_notices()를 다시 재정의하므로 그 이후가 자연스럽다).

-- =========================================================
-- 1. notifications.session_date 신규
-- =========================================================
alter table public.notifications add column if not exists session_date date;

comment on column public.notifications.session_date is
  '[ADR 0018] 이 알림이 가리키는 구체적인 날짜(기간제 프로그램의 특정 진행일 등). NULL이면 "프로그램
   전체에 대한 알림"(예: stale, 그리고 apply/enter/exit 같은 사건성 알림 전부 — 이 컬럼은 상태형
   알림에서만 의미가 있다). notifications_once_per_program_idx가 이 값을 키에 포함해 "같은 프로그램·
   같은 날짜"당 한 번만 상태형 알림이 뜨게 한다.';

-- =========================================================
-- 2. unique 인덱스 재정의 — session_date를 키에 포함
-- =========================================================
drop index if exists public.notifications_once_per_program_idx;

create unique index if not exists notifications_once_per_program_idx
  on public.notifications (recipient_id, program_id, type, coalesce(session_date, '0001-01-01'::date))
  where type in ('stale', 'upcoming', 'upcoming_admin', 'exit_due');

-- =========================================================
-- 3. sync_my_notices() 재정의 — 상태형 알림 insert마다 session_date를 채운다
--
-- [바뀐 부분만] 각 insert의 select 목록에 session_date 열이 하나씩 늘고, 그 값으로 무엇을 넣을지만
--   갈린다. 조건절(where)은 20260810180000판과 완전히 동일하다 — "언제 알림을 만들 것인가"는 하나도
--   안 바뀌었고 "같은 프로그램에서 몇 번 만들 수 있는가"만 바뀌었다.
--   - stale: session_date 없음(NULL) — 프로그램당 1번, 예전 그대로.
--   - upcoming_admin: v_tomorrow. 단일 일자든 기간제든 "내일"이 곧 이 알림이 가리키는 날짜다.
--   - upcoming(학생, 단일 일자·기간제 둘 다): v_tomorrow — 위와 같은 이유.
--   - exit_due(단일 일자): p.date — 그 프로그램의 유일한 날짜이자 놓친 날짜.
--   - exit_due(기간제): asess.session_date — attendance_sessions가 이미 "어느 날짜를 놓쳤는지"를
--     들고 있다. 이게 이번 수정의 핵심이다 — 예전엔 여러 날짜를 놓쳐도 첫 알림 이후로는 전부
--     on conflict do nothing에 막혀 조용히 사라졌다.
-- =========================================================
create or replace function public.sync_my_notices()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me       uuid := auth.uid();
  v_today    date;
  v_tomorrow date;
  v_total    integer := 0;
  v_n        integer;
begin
  if v_me is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;

  v_today    := public.today_kst();
  v_tomorrow := v_today + 1;

  if public.is_admin() then
    -- (1) stale — 프로그램 전체가 지났다는 사실은 날짜 하나로 쪼갤 수 없다. session_date 없음.
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select p.created_by, 'stale', '일정이 지난 프로그램이 있어요',
           p.title || ' · ' || to_char(coalesce(p.end_date, p.date), 'MM월 DD일') || ' 종료 · 내려도 괜찮아요',
           p.id
      from public.programs p
     where p.created_by = v_me
       and p.is_published = true
       and coalesce(p.end_date, p.date) < v_today
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    -- (2) upcoming_admin — [ADR 0018] session_date = v_tomorrow. 기간제는 진행일 전날마다 새로 뜬다
    --     (예전엔 기간 전체에서 딱 1번). 단일 일자는 "내일"이 하루뿐이라 결과가 예전과 같다.
    insert into public.notifications (recipient_id, type, message, detail, program_id, session_date)
    select p.created_by, 'upcoming_admin', '내일 진행하는 프로그램이 있어요',
           p.title || coalesce(' · ' || p.time, '') || ' · QR 스캔을 준비해 주세요',
           p.id, v_tomorrow
      from public.programs p
     where p.created_by = v_me
       and p.is_published = true
       and (
         (p.end_date is null and p.date = v_tomorrow)
         or (p.end_date is not null and v_tomorrow = any(p.session_dates))
       )
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

  else
    -- (3) upcoming(단일 일자) — [ADR 0018] session_date = v_tomorrow.
    insert into public.notifications (recipient_id, type, message, detail, program_id, session_date)
    select pa.student_id, 'upcoming', '내일 참여 예정 활동이 있어요',
           p.title || coalesce(' · ' || p.time, ''),
           p.id, v_tomorrow
      from public.participations pa
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and p.end_date is null
       and pa.status = 'applied'
       and p.date = v_tomorrow
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    -- (3-기간제) upcoming — [ADR 0018] session_date = v_tomorrow. 진행일 전날마다 새로 뜬다.
    insert into public.notifications (recipient_id, type, message, detail, program_id, session_date)
    select pa.student_id, 'upcoming', '내일 참여 예정 활동이 있어요',
           p.title || coalesce(' · ' || p.time, ''),
           p.id, v_tomorrow
      from public.participations pa
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and p.end_date is not null
       and pa.status in ('applied', 'entered')
       and v_tomorrow = any(p.session_dates)
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    -- (4) exit_due(단일 일자) — [ADR 0018] session_date = p.date(그 프로그램의 유일한 날짜).
    insert into public.notifications (recipient_id, type, message, detail, program_id, session_date)
    select pa.student_id, 'exit_due', '퇴장 인증이 남아 있어요',
           p.title || ' · 퇴장 인증을 마치면 포인트가 적립돼요',
           p.id, p.date
      from public.participations pa
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and p.end_date is null
       and pa.status = 'entered'
       and p.date < v_today
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    -- (4-기간제) exit_due — [ADR 0018] session_date = asess.session_date. 이번 수정의 핵심이다 —
    --     한 학생이 여러 날짜의 퇴장 인증을 놓쳐도(예: 1일차·3일차 둘 다) 이제 날짜마다 각각 뜬다.
    --     예전엔 (recipient, program, type)만 봐서 첫 미완료 알림 이후로는 전부 조용히 막혔다.
    insert into public.notifications (recipient_id, type, message, detail, program_id, session_date)
    select distinct pa.student_id, 'exit_due', '퇴장 인증이 남아 있어요',
           p.title || ' · 퇴장 인증을 마치면 포인트가 적립돼요',
           p.id, asess.session_date
      from public.attendance_sessions asess
      join public.participations pa on pa.id = asess.participation_id
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and asess.status = 'entered'
       and asess.session_date < v_today
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end if;

  return v_total;
end;
$$;

comment on function public.sync_my_notices() is
  '[ADR 0013 + 기간제 대응(20260810140000) + waitlisted 보정(20260810180000) + 진행일마다 발송
   (20260811160000/ADR 0018)] 상태형 알림을 한 곳에서 만든다. 관리자: stale + upcoming_admin.
   학생: upcoming(applied/entered 확정 참여만) + exit_due. 날짜 기준은 public.today_kst()로 통일했다.
   [멱등] notifications_once_per_program_idx(recipient, program, type, session_date 4열) + on conflict
   do nothing — 기간제는 이제 진행일마다 각각 한 번씩 뜬다(stale만 여전히 프로그램당 1번).
   [★ definer 라 RLS 우회 — 모든 where 절의 v_me 조건을 지우지 말 것] 지우면 전교생 알림 생성기가 된다.';

revoke all on function public.sync_my_notices() from public;
grant execute on function public.sync_my_notices() to authenticated;

-- =========================================================
-- 적용 후 확인
--   1) 진행일이 3개인 기간제 프로그램에 신청 -> 매 진행일 전날 sync_my_notices() 호출 시 그날짜의
--      upcoming이 새로 뜨는지(이전 진행일의 upcoming과 공존 — 둘 다 남아 있어야 함)
--   2) 같은 학생이 1일차·3일차 둘 다 퇴장 인증을 안 하고 두 날짜 모두 지난 뒤 sync_my_notices() 호출
--      -> exit_due가 session_date가 다른 2개 행으로 각각 뜨는지
--   3) stale은 여전히 같은 프로그램에서 여러 번 호출해도 1행만 남는지(회귀 확인)
--   4) 관리자 upcoming_admin도 진행일마다 다시 뜨는지
-- =========================================================
