-- Accumu v2 — 프로그램 담당 관리자 "이름만" 조회 (케빈 요청 2026-08-14 / ADR 0023)
--
-- [왜 함수가 필요한가 — 그냥 조인하면 안 되는 이유]
--   학생 화면의 참여 팝업에 "이 프로그램을 올린 관리자가 누구인가"를 보여주려는데,
--   public.profiles 의 select 정책은 딱 두 개뿐이다:
--     profiles_select_own                      (본인 행)
--     profiles_select_mentored_students_as_admin (관리자 -> 자기 담당 학생)
--   즉 **학생이 관리자 프로필을 읽는 경로는 없다.** programs 에 embed 조인을 걸면 에러가 아니라
--   조용히 null 이 와서 "이름 칸이 늘 비어 있는 화면"이 된다.
--
-- [정책을 새로 여는 대신 함수로 여는 이유 — 이게 이 마이그레이션의 핵심 판단]
--   "학생이 관리자 프로필을 select 할 수 있다"는 정책을 만들면 RLS 는 **행 단위**라 그 행의
--   모든 컬럼이 함께 열린다. profiles 에는 `code` 가 있고, 관리자의 code(ADM-0001)는 곧
--   **로그인 아이디**다(CLAUDE.md 4장 — {코드}@accumu.local). 이름을 보여주려다 전교생에게
--   관리자 계정 아이디를 뿌리는 셈이 된다. points_balance·career_interest 도 같이 딸려 나온다.
--   그래서 컬럼을 고를 수 있는 함수로 연다 — 나가는 값은 (program_id, 이름) 두 개뿐이고
--   관리자의 uuid·code·잔액은 어떤 경로로도 이 함수를 통해 나가지 않는다.
--   (program_applicant_counts() 가 "숫자만 내보내고 명단은 안 내보낸" 것과 같은 모양이다.)
--
-- [is_published = true 로 한정한다] 미게시 초안은 학생 화면에 아예 없다. 없는 프로그램의
--   담당자를 알려줄 이유가 없고, 초안 존재 자체가 새어나가지도 않는다.
--
-- [원칙 체크] 관리자가 새로 할 수 있게 된 일 0개(원칙 6 — 5종 그대로). 학생이 보는 것도
--   "이 활동 담당자 이름" 하나이고 순위·집계·명단이 아니다(원칙 1).
--   >>> 이 함수에 컬럼을 추가하지 말 것. 특히 profiles.code / points 계열은 절대 금지다.
--   >>> 반대 방향(관리자가 신청자 명단을 보는 것)은 ADR 0005 결정 7-2(d)로 계속 닫혀 있다.

create or replace function public.program_admin_names()
returns table(program_id uuid, admin_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, pr.name
    from public.programs p
    join public.profiles pr on pr.id = p.created_by
   where p.is_published = true
     and pr.role = 'admin';
$$;

comment on function public.program_admin_names() is
  '[ADR 0023] 게시된 프로그램의 담당 관리자 이름. (program_id, name) 두 컬럼만 반환한다 —
   관리자의 uuid·code(=로그인 아이디)·포인트는 나가지 않는다. security definer 인 이유는
   학생에게 profiles select 정책이 없어서다(정책을 열면 행 전체가 열려 code 까지 노출된다).
   created_by 가 NULL 인 프로그램은 결과에 나타나지 않는다(inner join) — 프런트는 없는
   program_id 를 "담당자 표시 없음"으로 다룰 것.';

revoke all on function public.program_admin_names() from public;
grant execute on function public.program_admin_names() to authenticated;

-- 적용 후 확인 (학생 계정 세션에서):
--   select * from public.program_admin_names();     -- 게시 프로그램마다 이름 한 줄
--   select code from public.profiles where role = 'admin';  -- 0행이어야 정상(정책 없음)
