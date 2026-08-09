-- Accumu v2 — 마이그레이션: 기간제 프로그램의 "실제 진행일" 명시적 목록
-- 배경(케빈): "기간을 선택할 때 지금은 시작일부터 종료일까지 전부가 되는데, 프로그램마다 주말만/평일만/
--   격일/특정요일마다처럼 다양하다. 날짜를 하나하나 체크하는 방식은 어때?"
--
-- [왜 요일 규칙(rrule)이 아니라 명시적 날짜 배열인가]
--   "격주"는 기준 요일이 있어야 계산되고, 공휴일 제외 같은 예외까지 넣으려면 규칙 엔진이 필요해진다.
--   날짜를 그대로 배열에 담으면 그 모든 패턴(그리고 패턴이 아닌 임의의 날짜 조합)을 규칙 없이 표현할 수
--   있다 — 관리자 폼의 "빠른 채우기"(매일/평일만/주말만/격일/요일 토글)는 그 배열을 채우는 도우미일 뿐,
--   저장되는 진실은 언제나 날짜 목록 그 자체다.
--
-- [date/end_date와의 관계] 두 컬럼은 여전히 "표시용 범위"(카드/아카이브의 날짜 범위 텍스트, 정렬,
--   "지난 프로그램" 판정)로 남는다. session_dates는 그 범위 안에서 실제로 진행하는 날짜만 골라낸 부분집합
--   이고, 항상 date = min(session_dates), end_date = max(session_dates)가 되도록 제약으로 강제한다
--   (그래야 기존 코드가 그대로 정확하다 — date/end_date를 읽는 곳을 전부 바꿀 필요가 없다).
--
-- 범위:
--   1) programs.session_dates date[] 컬럼 + 백필(기존 기간제 = 매일 진행이었으므로 전체 범위로 채움) + 제약 3개
--   2) programs_min_days_range 제약을 "달력 일수" 대신 "실제 진행일 수" 기준으로 재정의
--   3) issue_attendance_qr() 재정의 — 날짜 범위 검사를 session_dates 포함 여부 검사로 교체
--      (verify_attendance_qr()은 변경 없음 — "종료일 퇴장 = 마지막 날"이라는 그 함수의 전제가
--       end_date = max(session_dates) 제약으로 계속 성립하기 때문이다)
--
-- [실행 순서] 20260809160000 이후.

-- =========================================================
-- 1. programs.session_dates
-- =========================================================
alter table public.programs add column session_dates date[];

-- [백필] 20260809140000~160000 시절 만들어진 기간제 프로그램은 "범위 안 모든 날"이 진행일이었다.
--   그 동작을 그대로 배열로 못박는다 — 비워두면 이후 issue_attendance_qr이 모든 날을 거부하게 된다.
update public.programs
   set session_dates = array(select generate_series(date, end_date, interval '1 day')::date)
 where end_date is not null and session_dates is null;

alter table public.programs
  add constraint programs_session_dates_requires_period
    check (session_dates is null or end_date is not null);
alter table public.programs
  add constraint programs_period_requires_session_dates
    check (end_date is null or (session_dates is not null and array_length(session_dates, 1) > 0));
-- [범위 일치] date/end_date가 계속 "표시용 요약"으로 정확하려면 배열의 최소·최댓값과 같아야 한다.
--   이 제약이 곧 "session_dates의 모든 원소가 [date, end_date] 안에 있다"도 함께 보장한다
--   (최소·최댓값이 그 구간과 같다면 나머지 원소는 자동으로 그 사이다).
alter table public.programs
  add constraint programs_session_dates_bounds
    check (
      session_dates is null
      or (
        date = (select min(d) from unnest(session_dates) d)
        and end_date = (select max(d) from unnest(session_dates) d)
      )
    );

comment on column public.programs.session_dates is
  '기간제 프로그램의 실제 진행일 목록(오름차순일 필요는 없다 — 읽는 쪽이 정렬해서 쓴다). '
  '단일 일자 프로그램은 항상 NULL. 관리자 폼의 캘린더 그리드(빠른 채우기: 매일/평일만/주말만/격일/요일 토글)가 '
  '이 배열을 만든다. issue_attendance_qr()이 "오늘이 이 배열에 있는가"로 발급 가능 여부를 판정한다 — '
  '더 이상 date~end_date 범위 전체가 자동으로 진행일인 것은 아니다.';

-- [min_attendance_days 상한 재정의] 20260809160000의 programs_min_days_range는 "달력 일수"
--   (end_date - date + 1)를 상한으로 썼다 — 그때는 범위 안 모든 날이 진행일이라 같은 값이었다.
--   이제는 실제 진행일 수(array_length)가 진짜 상한이다(예: 8주 중 토요일만 8일 진행인데 최소참여일수를
--   10일로 걸면 절대 달성 불가능한 목표가 된다).
alter table public.programs drop constraint programs_min_days_range;
alter table public.programs
  add constraint programs_min_days_range
    check (
      min_attendance_days is null
      or (min_attendance_days > 0 and min_attendance_days <= coalesce(array_length(session_dates, 1), 0))
    );

-- =========================================================
-- 2. issue_attendance_qr() 재정의 — 날짜 범위 대신 session_dates 포함 여부
--
-- [이 함수 전체를 다시 쓰는 이유] Postgres는 함수 본문의 "일부"만 바꾸는 ALTER를 지원하지 않는다.
--   create or replace로 전체를 다시 선언해야 하며, 아래 로직은 20260809140000판과 동일하고
--   "날짜 범위 검사" 한 블록만 바뀌었다(주석 [바뀐 부분] 참고).
-- =========================================================
create or replace function public.issue_attendance_qr(p_participation_id uuid, p_type text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
  v_p       public.participations%rowtype;
  v_prog    public.programs%rowtype;
  v_today   date := current_date;
  v_sess    public.attendance_sessions%rowtype;
  v_token   text;
  v_expires timestamptz;
  v_try     integer := 0;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if p_type is null or p_type not in ('entry', 'exit') then
    raise exception '토큰 종류는 entry 또는 exit 여야 합니다.' using errcode = '22023';
  end if;

  -- 본인 행만. for update 로 잠가 동시 발급 요청을 직렬화한다 (issue_participation_qr 과 동일 패턴).
  select * into v_p
    from public.participations
   where id = p_participation_id
     and student_id = v_student
   for update;
  if not found then
    raise exception '본인의 참여 건이 아닙니다.' using errcode = '42501';
  end if;

  select * into v_prog from public.programs where id = v_p.program_id;
  if not found or v_prog.end_date is null then
    -- 단일 일자 프로그램은 issue_participation_qr 을 쓴다. 여기로 잘못 오면 조용히 거부한다.
    return jsonb_build_object('ok', false, 'reason', 'not_period_program');
  end if;

  if v_p.status = 'completed' then
    return jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;

  -- [바뀐 부분 — 20260809180000] "범위 안이면 전부 진행일"이 아니라 "이 배열에 있어야 진행일"이다.
  --   session_dates가 NULL인 레거시 행은 있을 수 없다(programs_period_requires_session_dates가 막는다 +
  --   위 백필이 이미 채웠다) — 그래도 혹시 NULL이면 any()가 NULL을 돌려주므로 아래 not (...)이 그대로 참이 되어
  --   fail-closed(거부)로 떨어진다.
  if not (v_today = any(v_prog.session_dates)) then
    return jsonb_build_object('ok', false, 'reason', 'not_a_session_day');
  end if;

  select * into v_sess
    from public.attendance_sessions
   where participation_id = v_p.id and session_date = v_today
   for update;

  if not found then
    if p_type = 'exit' then
      -- 오늘 입장도 안 했는데 퇴장 토큰을 요청 = 순서 위반. 행을 만들지 않고 바로 거부한다.
      return jsonb_build_object('ok', false, 'reason', 'wrong_order');
    end if;
    insert into public.attendance_sessions (participation_id, session_date)
    values (v_p.id, v_today)
    returning * into v_sess;
  end if;

  if v_sess.status = 'completed' then
    return jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;
  if p_type = 'entry' and v_sess.status <> 'applied' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_order');
  end if;
  if p_type = 'exit' and v_sess.status <> 'entered' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_order');
  end if;

  -- 컬럼 간·테이블 간 충돌까지 막는다 (participations 토큰과도 겹치지 않아야 한다 — 검증 함수가
  -- entry_token 을 먼저 participations 에서, 없으면 attendance_sessions 에서 찾기 때문).
  loop
    v_try := v_try + 1;
    v_token := public.qr_generate_token();
    exit when not exists (
      select 1 from public.participations where entry_token = v_token or exit_token = v_token
      union all
      select 1 from public.attendance_sessions where entry_token = v_token or exit_token = v_token
    );
    if v_try >= 5 then
      raise exception '토큰 생성에 실패했습니다.' using errcode = '55000';
    end if;
  end loop;

  v_expires := now() + interval '30 minutes'; -- CLAUDE.md 6장과 동일한 만료 정책.

  if p_type = 'entry' then
    update public.attendance_sessions
       set entry_token = v_token, entry_token_expires_at = v_expires
     where id = v_sess.id;
  else
    update public.attendance_sessions
       set exit_token = v_token, exit_token_expires_at = v_expires
     where id = v_sess.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'participation_id', v_p.id,
    'session_date', v_today,
    'type', p_type,
    'token', v_token,
    'expires_at', v_expires
  );
end;
$$;

comment on function public.issue_attendance_qr(uuid, text) is
  '학생 본인의 "오늘" 출석 세션 QR 토큰 발급(30분 만료, 호출마다 재발급). [20260809180000] 발급 가능 여부는
   date~end_date 범위가 아니라 programs.session_dates 에 오늘이 포함되는가로 판정한다 — 주말만/평일만/
   격일/특정요일 등 관리자가 고른 진행일에만 QR이 뜬다. 이 함수는 status 를 전진시키지 않는다(발급은
   관리자 스캔과 무관하게 여러 번 가능해야 하므로). 대상 날짜는 인자로 받지 않고 서버가 current_date 로
   계산한다.';

revoke all on function public.issue_attendance_qr(uuid, text) from public;
grant execute on function public.issue_attendance_qr(uuid, text) to authenticated;
