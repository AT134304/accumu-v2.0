-- Accumu v2 — 수정: sync_my_notices() 가 기간제 프로그램을 몰랐던 버그
--
-- [원인] sync_my_notices()(20260808140000, ADR 0013 후속)는 기간제 프로그램(programs.end_date/
--   session_dates, attendance_sessions — 20260809140000~180000)이 생기기 전에 짜였고, 그 뒤로
--   손대지 않았다. 네 조건 전부 "프로그램은 하루짜리"를 전제한다:
--
--   1) stale(관리자, 일정 지난 게시중)   — p.date < 오늘 만 본다. 8일짜리 프로그램이 3일째 진행
--      중이어도 시작일이 지났다는 이유로 "일정이 지났어요, 내려도 돼요"를 잘못 띄운다.
--   2) upcoming_admin(관리자, 내일 진행) — p.date = 내일 만 본다. 시작일 전날에만 뜨고, 2일차·
--      3일차... 진행일 전날에는 안 뜬다.
--   3) upcoming(학생, 내일 참여 예정)    — pa.status = 'applied' 를 조건에 걸었다. 기간제는 첫날
--      입장 이후 마지막 날까지 내내 'entered' 라 이 조건이 둘째 날부터 영원히 거짓이 된다.
--   4) exit_due(학생, 퇴장 인증 남음)    — 가장 심각하다. pa.status = 'entered' and p.date < 오늘 은
--      기간제에서 "정상적으로 진행 중"인 상태와 정확히 같은 모양이다. 프로그램이 시작된 다음날부터
--      끝날 때까지 매일 "퇴장 인증이 남아 있어요"를 잘못 띄운다 — 학생은 아무것도 안 놓쳤다.
--
-- [고친 방법] 네 조건 모두 "그 프로그램이 기간제인가"로 먼저 갈라 별도 판정을 추가했다.
--   기존 단일 일자 조건은 end_date is null 가드를 더했을 뿐 로직을 바꾸지 않았다 — 회귀가 없다.
--   기간제 exit_due 만 attendance_sessions 를 새로 조인한다(participations.status 로는 "그 날" 을
--   판정할 수 없어서다 — status 는 참여 전체 진행도이지 일자별 상태가 아니다).
--
-- [알려진 열화 — 기존 upcoming 의 한계를 그대로 물려받는다]
--   notifications_once_per_program_idx 가 (recipient, program, type) 당 1행만 허용한다. 즉 기간제
--   프로그램의 "내일 참여 예정" 은 그 프로그램 전체에서 딱 한 번만 뜬다(어느 진행일 전날이든 학생이
--   가장 먼저 화면을 연 그 시점 1회) — 진행일마다 매번 뜨지 않는다. 이건 이번에 만든 제약이 아니라
--   ADR 0013 후속 마이그레이션이 이미 감수한 "지연 계산의 대가"를 기간제로 확장 적용한 것뿐이다.
--   >>> 진행일마다 알림을 새로 만들려고 이 unique 인덱스를 (recipient, program, type, session_date)
--       로 넓히지 말 것 — 그 순간 event 성 알림(mentee 등)과 다른 규율이 생겨 코드를 읽는 사람이
--       "왜 여기만 4열 unique 인가"를 다시 추적해야 한다. 필요해지면 별도 ADR로 결정할 것.
--
-- [실행 순서] 20260809180000(session_dates) 이후.

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

  -- 날짜 기준은 KST. programs.date 는 date 컬럼이라 그 자체가 한국 달력의 날짜다.
  v_today    := (now() at time zone 'Asia/Seoul')::date;
  v_tomorrow := v_today + 1;

  if public.is_admin() then
    -- (1) stale — 일정이 지났는데 아직 게시중.
    --     [바뀐 부분] 기간제는 "일정"이 date 하루가 아니라 date~end_date 전체다. coalesce 로
    --     단일 일자(end_date null)와 기간제를 한 식에서 같이 판정한다 — 조건이 갈라져도 뜻은 같다
    --     ("이 프로그램이 실제로 진행되는 마지막 날").
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

    -- (2) upcoming_admin — 내일 진행. "QR 스캔 준비" 는 관리자 기능 3종 안의 사실이다(원칙 6).
    --     [바뀐 부분] 단일 일자는 date = 내일, 기간제는 "내일이 진행일 목록에 있는가"로 갈린다.
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select p.created_by, 'upcoming_admin', '내일 진행하는 프로그램이 있어요',
           p.title || coalesce(' · ' || p.time, '') || ' · QR 스캔을 준비해 주세요',
           p.id
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
    -- (3) upcoming — 내일 참여 예정.
    --     [단일 일자 — 그대로] 아직 입장 전(applied)인 건만. 하루짜리라 이 상태가 "신청만 하고
    --     아직 시작 안 함" 과 정확히 같다.
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select pa.student_id, 'upcoming', '내일 참여 예정 활동이 있어요',
           p.title || coalesce(' · ' || p.time, ''),
           p.id
      from public.participations pa
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and p.end_date is null
       and pa.status = 'applied'
       and p.date = v_tomorrow
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    -- (3-기간제) upcoming — 기간제는 'applied' 로 판정할 수 없다(둘째 날부터 영원히 'entered').
    --     대신 "참여 전체가 아직 안 끝났고(완료가 아니고) 내일이 진행일이다"로 판정한다.
    --     참여를 아직 신청도 안 한 사람은 애초에 이 join에 걸리지 않으므로 "신청 여부" 조건이 따로
    --     필요 없다 — participations 행 자체가 신청의 증거다(ADR 0004 구현 가이드 4번과 같은 논리).
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select pa.student_id, 'upcoming', '내일 참여 예정 활동이 있어요',
           p.title || coalesce(' · ' || p.time, ''),
           p.id
      from public.participations pa
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and p.end_date is not null
       and pa.status <> 'completed'
       and v_tomorrow = any(p.session_dates)
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    -- (4) exit_due — 입장은 했는데 퇴장 인증이 없다. 그 상태로는 포인트가 지급되지 않는다.
    --     [원칙 5 를 깎지 않는다] 알림은 "남아 있다"고 알릴 뿐 퇴장을 대신 처리하지 않는다.
    --     퇴장은 여전히 관리자 QR 스캔만이 완료시킨다.
    --     [원칙 4] 제목은 인증 이야기이고 포인트는 부가 줄이다.
    --     [단일 일자만 — end_date is null 가드 추가] 기간제는 아래 (4-기간제)가 담당한다.
    --     participations.status='entered' 는 기간제에서 "정상 진행 중"과 구분이 안 된다(위 설명 참고).
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select pa.student_id, 'exit_due', '퇴장 인증이 남아 있어요',
           p.title || ' · 퇴장 인증을 마치면 포인트가 적립돼요',
           p.id
      from public.participations pa
      join public.programs p on p.id = pa.program_id
     where pa.student_id = v_me
       and p.end_date is null
       and pa.status = 'entered'
       and p.date < v_today
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;

    -- (4-기간제) exit_due — participations 가 아니라 attendance_sessions 를 본다. "그날 입장은
    --     했는데 그날 퇴장을 안 한" 세션이 있고 그 날짜가 이미 지났으면 알린다. 참여 전체가
    --     이미 completed 여도(다른 날 정상적으로 끝났어도) 과거의 미완료 세션은 그대로 사실이라
    --     pa.status 를 조건에 넣지 않는다.
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    select distinct pa.student_id, 'exit_due', '퇴장 인증이 남아 있어요',
           p.title || ' · 퇴장 인증을 마치면 포인트가 적립돼요',
           p.id
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
  '[ADR 0013 + 기간제 대응 수정(20260810140000)] 상태형 알림을 한 곳에서 만든다. '
  '관리자: stale(일정 지난 게시중) + upcoming_admin(내일 진행). '
  '학생: upcoming(내일 참여 예정) + exit_due(퇴장 인증 미완료). 네 조건 모두 단일 일자/기간제를 갈라 '
  '판정한다(기간제는 programs.session_dates 또는 attendance_sessions 를 본다 — participations.status '
  '하나로는 "그 날"을 판정할 수 없다). '
  '[트리거가 아닌 이유] "내일이다"/"지났다" 는 사건이 아니라 시간이 지나면 참이 되는 상태라 트리거가 '
  '깨어날 계기가 없다. 답이 날짜의 함수라 화면이 열릴 때 계산한다(pg_cron 을 켜지 않는다). '
  '[멱등] notifications_once_per_program_idx + on conflict do nothing — 기간제는 프로그램 전체에서 '
  '해당 알림이 한 번만 뜬다(진행일마다 X). '
  '[알리기만 한다] programs/participations 를 update 하지 않는다. '
  '[★ definer 라 RLS 우회 — 모든 where 절의 v_me 조건을 지우지 말 것] 지우면 전교생 알림 생성기가 된다.';

revoke all on function public.sync_my_notices() from public;
grant execute on function public.sync_my_notices() to authenticated;
