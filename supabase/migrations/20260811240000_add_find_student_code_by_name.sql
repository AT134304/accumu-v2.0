-- Accumu v2 — 이름으로 학번 찾기 (ADR 0020)
--
-- [배경] 로그인 화면 "아이디를 잊으셨나요?"에서 학교 계정 학생이 이름만 대고 자기 학번을 다시
-- 확인할 수 있게 한다. 관리자 코드/개인 계정 이메일은 이 함수의 대상이 아니다 — 관리자는 "아이디
-- 찾기"랄 게 없고(코드를 잊으면 운영자 문의), 개인 계정은 이메일 자체가 아이디라 애초에 조회할
-- "다른 무엇"이 없다.
--
-- [★ 학번 노출을 수용하는 이유 — 새로 여는 결정이 아니라 ADR 0008 결정 4의 연장]
--   check_signup_availability()(20260731120000)는 이미 "학번은 교실에서 공개적으로 쓰이는
--   식별자이고 비밀번호 없이는 아무것도 되지 않는다"는 판단으로 code_taken(학번 존재 여부)을
--   anon에게 노출해 왔다. 이 함수는 "존재하는가"를 "그 이름의 학번이 무엇인가"로 한 단계 넓힐
--   뿐이다 — 같은 판단, 같은 위험 등급이다.
-- [정확히 일치하는 이름 1명일 때만] 부분 일치·유사 검색을 하지 않는다. 동명이인(2명 이상)이면
--   어느 쪽인지 추측하지 않고 ambiguous로 답한다 — 틀린 학번을 알려주는 것보다 안전하다.
-- [rate limit을 걸지 않은 이유] check_signup_availability도 원래 무제한이다(같은 위험 등급이므로
--   여기만 특별히 막을 이유가 약하다). ADR 0017의 link_school_account rate limit은 "로그인한 계정
--   하나로 수만 번을 값싸게 반복할 수 있다"는 다른 종류의 위험이었다 — 이 함수는 매번 별도 HTTP
--   요청이 필요해 비용 구조가 다르다. 필요해지면 그때 같은 패턴(실패 카운터+쿨다운)을 추가할 것.

create or replace function public.find_student_code_by_name(p_name text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_name    text := trim(coalesce(p_name, ''));
  v_matches text[];
begin
  if v_name = '' then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select array_agg(p.code) into v_matches
    from public.profiles p
   where p.role = 'student'
     and p.account_type = 'school'
     and trim(p.name) = v_name;

  if v_matches is null or array_length(v_matches, 1) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if array_length(v_matches, 1) > 1 then
    return jsonb_build_object('ok', false, 'reason', 'ambiguous');
  end if;

  return jsonb_build_object('ok', true, 'code', v_matches[1]);
end;
$$;

comment on function public.find_student_code_by_name(text) is
  '[ADR 0020] 학교 계정 학생의 학번을 이름으로 찾는다(로그인 화면 "아이디를 잊으셨나요?"). 정확히
   일치하는 이름 1명일 때만 학번을 돌려준다 — 0명이면 not_found, 2명 이상이면 ambiguous(추측하지
   않는다). [학번 노출 수용] ADR 0008 결정 4가 이미 학번 존재 여부(code_taken)를 노출해 왔다 — 같은
   판단의 연장이다. anon도 호출 가능(로그인 전 화면). 이름 외 다른 입력을 받지 않고, 학번 외
   다른 정보(다른 프로필 필드)를 반환하지 않는다.';

revoke all on function public.find_student_code_by_name(text) from public;
grant execute on function public.find_student_code_by_name(text) to anon, authenticated;

-- =========================================================
-- 적용 후 확인
--   1) 실제 학교 계정 학생 이름으로 호출 -> {ok:true, code:'...'}
--   2) 존재하지 않는 이름 -> {ok:false, reason:'not_found'}
--   3) 동명이인 시드(있다면) -> {ok:false, reason:'ambiguous'}
--   4) 개인 계정 학생 이름으로 호출해도 not_found(account_type='school' 조건에 안 걸림)
-- =========================================================
