-- Accumu v2 — 본인 학교 변경 (케빈 요청 2026-08-14)
--
-- [왜 RPC 인가] profiles 에는 update 정책이 0개다(ADR 0002 이래의 규율). 프로필의 어떤 값이든
--   바꾸는 경로는 "그 컬럼만 건드리는 security definer 함수" 하나씩이다 — set_career_interest(),
--   link_school_account() 와 같은 형태다. 정책을 열면 SET 목록을 DB 가 아니라 클라이언트가 정하게 된다.
--
-- [★ 이 값은 로그인 자격의 일부다] 학교 계정 학생은 학번·이름·비밀번호·**학교** 4가지로 로그인한다
--   (20260814180000). 이 함수를 부르는 순간 그 학생의 로그인 방법이 바뀐다 —
--   화면은 반드시 그 사실을 먼저 말해야 한다(StudentMyPage 의 확인 문구).
--
-- [누가 부를 수 있나]
--   - 관리자        : 가능. 자기 계정 정보다.
--   - 학교 계정 학생 : 가능. 자기가 가입 때 적은 값을 고치는 것이다(오타 수정이 주 용도).
--   - 개인 계정 학생 : **거부.** 소속이 없는 계정이라 학교라는 값이 성립하지 않는다.
--     학교에 속하려면 초대코드로 link_school_account() 를 타야 한다(ADR 0008 결정 5) — 그 경로를
--     우회해 "학교 이름만 적힌 개인 계정"을 만들 수 있게 하면 school/personal 구분이 흐려진다.
--
-- [원칙 6] 관리자가 새로 할 수 있게 된 일은 **자기 계정 정보 수정**뿐이다. 남의 학교를 바꾸는
--   경로가 아니다 — v_uid 로 자기 행만 잠근다.
--   >>> p_student_id 같은 인자를 추가하지 말 것. 그 순간 "관리자가 학생 정보를 고치는 도구"가 되고
--   >>> 담당 학생 5명의 소속을 관리자가 좌우하게 된다(ADR 0005 결정 7-2 의 경계를 넘는다).

create or replace function public.set_my_school(p_school text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_school text := nullif(btrim(coalesce(p_school, '')), '');
  v_prof   public.profiles;
begin
  if v_uid is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if v_school is null then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;
  if length(v_school) > 60 then
    return jsonb_build_object('ok', false, 'reason', 'too_long');
  end if;

  select * into v_prof from public.profiles where id = v_uid;
  if not found then
    raise exception '프로필을 찾을 수 없습니다.' using errcode = '42501';
  end if;

  -- 개인 계정은 소속이 없다(위 주석). 관리자는 account_type 이 NULL 이라 이 조건을 타지 않는다.
  if v_prof.role = 'student' and v_prof.account_type is distinct from 'school' then
    return jsonb_build_object('ok', false, 'reason', 'not_school_account');
  end if;

  update public.profiles
     set school = v_school          -- SET 목록은 이 한 컬럼뿐이다. 여기가 컬럼 경계다.
   where id = v_uid;

  return jsonb_build_object('ok', true, 'school', v_school);
end;
$$;

comment on function public.set_my_school(text) is
  '[2026-08-14] 로그인한 본인의 profiles.school 을 바꾼다. 학교 계정 학생과 관리자만 호출할 수 있다 '
  '(개인 계정은 소속이 없어 not_school_account 로 거부 — 학교에 속하려면 link_school_account 를 탄다). '
  '[주의] 학교 계정 학생에게 이 값은 로그인 4번째 대조 항목이라, 바꾸면 다음 로그인부터 새 값을 '
  '입력해야 한다. 화면이 그 사실을 먼저 고지해야 한다. '
  '자기 행만 바꾼다 — 남의 학교를 바꾸는 인자를 추가하지 말 것(원칙 6).';

revoke all on function public.set_my_school(text) from public;
grant execute on function public.set_my_school(text) to authenticated;

-- 적용 후 확인 (학생/관리자 세션에서):
--   select public.set_my_school('가온고등학교');   -- {"ok": true, "school": "가온고등학교"}
--   select public.set_my_school('   ');            -- {"ok": false, "reason": "empty"}
