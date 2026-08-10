-- Accumu v2 — 마이그레이션: 담당 학생 해제 + 관리자의 담당 학생 포인트 열람
-- 배경(케빈, 2026-08-10): "관리자 페이지에서 학생이 초대 코드 입력하면 추가되는데 그 반대로
--   학생 추방 기능도 만들어줘. 그러고 관리자가 학생이 모은 포인트 확인 할 수 있게 해줘."
--
-- [원칙을 깨는 결정임을 분명히 한다] CLAUDE.md 원칙 6("관리자 기능 3종 한정")과 원칙 4의
-- 포인트 노출 가드를 의도적으로 개정한다. 근거·범위는 docs/adr/0015-mentor-removal-and-point-visibility.md.
-- 이 마이그레이션은 그 ADR의 구현분이다.
--
-- 범위:
--   1) mentor_students DELETE 정책 1개 — 관리자가 "내가 담당하는" 매핑만 지울 수 있다.
--   2) link_school_account() 재정의 — "이미 연동됨" 판정을 profiles.account_type 대신
--      mentor_students 행의 실제 존재 여부로 바꾼다. 해제된 학생이 (같은/다른) 초대코드로
--      다시 연동될 수 있어야 "추방"이 진짜 되돌릴 수 있는 동작이 된다.
--   [포인트 열람에는 마이그레이션이 필요 없다] profiles_select_mentored_students_as_admin
--   (20260723120000) 이 이미 담당 학생 행의 모든 컬럼을 열어준다 — points_balance/points_total
--   포함. 지금까지 안 보여준 건 RLS 가 아니라 프런트(archiveService.js)의 select 목록 선택이었다.
--   그 부분은 코드만 바꾸면 된다(다음 커밋).
--
-- [실행 순서] 20260731120000(link_school_account 최초 정의) 이후 아무 때나.

-- =========================================================
-- 1. mentor_students_delete_own_as_admin
--
-- [RLS 권한 경계]
--   대상 역할: authenticated
--   허용 행: admin_id = auth.uid() 인 행만 (= 내가 담당하는 매핑)
--   불가능: 다른 관리자의 매핑 삭제(그런 행은 애초에 admin_id 가 나와 다르니 대상이 아니다),
--           학생이 자기 매핑을 스스로 지우는 것(학생의 uuid 가 어떤 매핑의 admin_id 와도 같을 수 없다
--           — 시딩/handle_new_user 가 그 값 공간을 admin_id=관리자로만 채운다).
--   [select 정책과 완전히 같은 조건을 쓴다] mentor_students_select_own_as_admin(20260723120000)과
--   동일하게 is_admin() 을 별도로 부르지 않는다 — admin_id = auth.uid() 자체가 "학생 uuid는 애초에
--   이 컬럼 값 공간에 없다"는 사실로 이미 좁혀져 있다(그 select 정책의 주석과 같은 논리).
--   [삭제되는 것은 관계뿐이다] 이 delete 는 mentor_students 1행만 지운다. 학생의 profiles/
--   participations/point_transactions 는 어디에서도 참조하지 않아 그대로 남는다 — "추방"은
--   그 관리자의 시야에서 빠지는 것이지 학생 기록 삭제가 아니다.
create policy "mentor_students_delete_own_as_admin"
  on public.mentor_students
  for delete
  to authenticated
  using (admin_id = auth.uid());

comment on table public.mentor_students is
  '관리자-담당학생 매핑. admin_id가 실제 role=admin 행인지, student_id가 실제 role=student 행인지는 '
  'DB 레벨 CHECK/트리거로 강제하지 않고 시딩 스크립트(scripts/seed-accounts.mjs) 책임으로 둔다 (ADR 0002). '
  '[ADR 0005 경고] 이 테이블이 "관리자가 남의 profiles/participations 를 볼 수 있는 행 경계"다. '
  '[ADR 0015 — 2026-08-10] insert는 여전히 앱 경로가 없다(시딩 + link_school_account() 둘뿐). '
  'delete는 이제 관리자 본인 축(admin_id=auth.uid())으로 1개 열려 있다 — "담당 해제" 기능(원칙 6 개정).';

-- =========================================================
-- 2. link_school_account() 재정의 — "이미 연동됨" 판정 기준 변경
--
-- [기존 문제] 원래 이 함수는 profiles.account_type = 'school' 이면 무조건 already_linked 를
--   반환했다. account_type 은 한 번 school 이 되면 절대 되돌아가지 않는 컬럼이라(ADR 0008 결정 5),
--   관리자가 mentor_students 행을 지워도(위 1번) 그 학생은 이 함수로 다시는 어떤 관리자와도
--   연동될 수 없었다 — "추방"이 영구 고아 상태를 만드는 것과 같았다.
-- [고친 것] 판정 기준을 "mentor_students 에 내 행이 있는가"로 바꿨다. account_type 은 여전히
--   한 번 school 이 되면 되돌아가지 않지만(그 결정은 그대로다 — SET 목록도 안 바꿨다), "이미
--   연동됨"의 의미가 "역사적으로 한 번이라도 school 이었다"에서 "지금 담당 관리자가 있다"로
--   바뀌었다. 정상적으로 담당이 있는 학생은 동작이 전혀 달라지지 않는다(여전히 즉시 already_linked).
--   담당이 없어진(추방된) 학생만 새로 통과한다.
create or replace function public.link_school_account(p_invite text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
  v_invite  text := public.invite_normalize(p_invite);
  v_admin   uuid;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if public.is_admin() then
    -- 관리자에게는 소속 개념이 없다. 관리자가 다른 관리자의 담당이 되는 구조를 만들지 않는다.
    raise exception '학생만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles p where p.id = v_student) then
    raise exception '프로필을 찾을 수 없습니다.' using errcode = '42501';
  end if;

  -- [바뀐 부분 — ADR 0015] "이미 연동됨"을 account_type이 아니라 실제 매핑 존재로 판정한다.
  if exists (select 1 from public.mentor_students ms where ms.student_id = v_student) then
    return jsonb_build_object('ok', false, 'reason', 'already_linked');
  end if;

  select ic.admin_id into v_admin
    from public.invite_codes ic
   where ic.code = v_invite and ic.kind = 'school' and ic.is_active;
  if v_admin is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_invite');
  end if;

  update public.profiles
     set account_type = 'school'     -- SET 목록은 이 한 컬럼뿐이다(그대로 유지 — ADR 0008 결정 5)
   where id = v_student;

  insert into public.mentor_students (admin_id, student_id)
  values (v_admin, v_student)
  on conflict (admin_id, student_id) do nothing;

  return jsonb_build_object('ok', true, 'account_type', 'school');
end;
$$;

comment on function public.link_school_account(text) is
  '[ADR 0008 결정 5 + ADR 0015] 개인 계정 학생이 초대코드로 학교 계정이 되는 경로이자, 담당이 해제된
   ("추방된") 학교 계정 학생이 (같은/다른 관리자에게) 다시 연동되는 경로다. UPDATE SET 목록이
   account_type 하나뿐이라 points_*/role/code 는 이 경로로 바뀔 수 없다. 학생 id를 인자로 받지 않으므로
   남을 남의 담당에 넣을 수 없다. "이미 연동됨" 판정은 mentor_students 행 존재 여부다(account_type 이력이
   아니다) — 그래서 담당이 해제된 학생만 다시 통과한다.';

revoke all on function public.link_school_account(text) from public;
grant execute on function public.link_school_account(text) to authenticated;
