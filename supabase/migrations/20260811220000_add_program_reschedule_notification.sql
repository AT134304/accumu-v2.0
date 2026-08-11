-- Accumu v2 — 프로그램 일정 변경 시 신청자 알림 (ADR 0018)
--
-- [배경] 케빈이 지목한 사용성 문제 11번: "프로그램 수정해도 이미 신청한 학생에게 알림 안 감". 관리자가
--   날짜·시간을 바꿔도 이미 신청한(또는 대기 중인) 학생은 조용히 아무것도 모른 채로 남았다.
--
-- [트리거인 이유] 프로그램 수정은 RPC가 아니라 RLS(programs_update_own_as_admin)를 통과하는 평범한
--   update()다(programService.js patchProgramRow) — "누가 저장을 눌렀는가"를 가로챌 단일 진입점이
--   없다. 이 테이블에는 이미 같은 이유로 만들어진 선례가 있다 —
--   notifications_on_program_published()(20260806120000, 게시 순간을 잡는 AFTER UPDATE 트리거).
--   같은 패턴을 "일정이 바뀌는 순간"에 하나 더 붙인다.
-- [팬아웃 대상] 이 트리거는 학생 수만큼이 아니라 "그 프로그램에 신청/대기 중인 학생 수"만큼만 판다
--   (게시 알림처럼 전교생에게 쏘지 않는다 — 일정 변경은 그 프로그램과 관계있는 사람에게만 의미가 있다).
--   대상 status: applied/entered/waitlisted. completed는 이미 그 활동을 마쳤으니 지금 와서 일정이
--   바뀌어도 상관없는 사람들이다.
-- [무엇을 "일정 변경"으로 보는가] date/end_date/time/session_dates 넷 중 하나라도 달라지면. capacity·
--   points·description 같은 다른 컬럼 변경은 알리지 않는다 — "언제"가 바뀌어야 신청자의 실제 계획이
--   틀어진다. session_dates까지 포함한 이유는 기간제 프로그램에서 date/end_date(기간의 양 끝)는 그대로
--   두고 중간 진행일만 바꾸는 경우(예: 특정 날짜를 빼고 다른 날짜로 교체)가 있어서다.
-- [게시된 프로그램만] new.is_published = false(초안이거나 방금 내려간)면 신청자에게 보일 화면 자체가
--   없으니 알리지 않는다.
--
-- [선행 조건] 20260808100000을 먼저(재실행) — 'rescheduled' 값이 필요하다(55P04).

create or replace function public.notifications_on_program_rescheduled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed boolean;
begin
  v_changed :=
    new.date is distinct from old.date
    or new.end_date is distinct from old.end_date
    or new.time is distinct from old.time
    or new.session_dates is distinct from old.session_dates;

  if not v_changed or not new.is_published then
    return new;
  end if;

  insert into public.notifications (recipient_id, type, message, detail, program_id)
  select pa.student_id, 'rescheduled', '신청한 프로그램의 일정이 바뀌었어요',
         new.title || ' · ' ||
           case
             when new.end_date is not null
               then to_char(new.date, 'MM월 DD일') || '~' || to_char(new.end_date, 'MM월 DD일')
             else to_char(new.date, 'MM월 DD일')
           end ||
           coalesce(' ' || new.time, ''),
         new.id
    from public.participations pa
   where pa.program_id = new.id
     and pa.status in ('applied', 'entered', 'waitlisted');

  return new;
end;
$$;

comment on function public.notifications_on_program_rescheduled() is
  '[ADR 0018] 프로그램의 date/end_date/time/session_dates 중 하나라도 바뀌고 게시 중이면, 그 프로그램에
   신청·대기 중인(applied/entered/waitlisted) 학생 전원에게 알린다(type=rescheduled). completed는
   대상이 아니다 — 이미 끝난 활동이라 일정 변경이 그들의 계획에 영향을 주지 않는다. 신청자 수만큼만
   판다(notifications_on_program_published처럼 전교생에게 쏘지 않는다) — 팬아웃 규모가 참여자 수로
   자연히 제한된다.';

drop trigger if exists notifications_on_program_rescheduled_update on public.programs;
create trigger notifications_on_program_rescheduled_update
  after update on public.programs
  for each row execute function public.notifications_on_program_rescheduled();

-- =========================================================
-- 적용 후 확인
--   1) 학생 A(applied)·B(waitlisted)가 신청한 게시중 프로그램의 date를 관리자가 수정
--   2) A·B 둘 다 "신청한 프로그램의 일정이 바뀌었어요" 알림을 받는지
--   3) completed 상태인 다른 학생 C는 알림을 안 받는지
--   4) date/time/end_date/session_dates 중 아무것도 안 바꾸고 title/points만 바꾸면 알림이 안 뜨는지
--   5) 미게시(초안) 프로그램의 날짜를 바꿔도 알림이 안 뜨는지
-- =========================================================
