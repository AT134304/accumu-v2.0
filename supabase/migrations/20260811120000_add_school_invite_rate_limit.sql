-- Accumu v2 — 학교 초대코드 무차별 대입(brute force) 완화 (ADR 0017)
--
-- [배경 — 케빈, 2026-08-11] ADR 0016이 "초대코드 유출 방지는 나중에"로 미뤄뒀던 것의 후속.
--   구체적으로 물었더니 답은 "학생화면에서 다시 초대코드 확인 못하게" — 즉 link_school_account()가
--   무제한으로 불러도 되는 "이 코드 맞아요/틀려요" oracle이라는 점을 막아 달라는 요청이었다.
--   SCH-XXXX 코드는 'SCH-' + md5 앞 4자(16^4 = 65,536가지) — 개인 계정 학생이 로그인한 채로
--   link_school_account를 계속 다른 값으로 호출하면 이론상 전수 조사가 가능했다.
--
-- [범위] link_school_account()만 고친다. 회원가입 화면의 check_signup_availability()(익명 호출,
--   학교/관리자 초대코드 유효성도 검사한다)는 같은 종류의 oracle이지만 "학생화면"이 아니라 로그인 전
--   화면이고, 계정 생성 없이는 재시도가 안 되는(관리자 코드는 계정까지 생겨버린다) 다른 성격의
--   문제라 이번 범위에 넣지 않는다 — 알려진 사항으로 ADR 0017에 남긴다.
--
-- [설계 — 계정별 실패 카운터 + 쿨다운, 새 테이블 없이 profiles 확장]
--   그 학생만의 카운터라 시도할 수 있는 인원 자체가 "학생 계정 하나"로 좁다(계정을 새로 여러 개
--   만들려면 그때마다 학번+비밀번호로 회원가입해야 해서 단순 반복 호출보다 훨씬 비싸다).
--   5회 연속 실패 시 15분 잠금 — 잠금 중엔 코드가 맞아도 통과시키지 않는다(목적이 "이번 시도의
--   정오답"이 아니라 "짧은 시간에 몇 번 시도했는가"를 늦추는 것이라서).
--
-- [실행 순서] 20260810120000(link_school_account 최신판) 이후 아무 때나.

-- =========================================================
-- 1. profiles 확장 — 실패 카운터 + 잠금 시각
-- =========================================================
alter table public.profiles
  add column if not exists school_link_fail_count integer not null default 0,
  add column if not exists school_link_locked_until timestamptz;

comment on column public.profiles.school_link_fail_count is
  '학교 초대코드 연동(link_school_account) 연속 실패 횟수. 성공하거나 잠금이 걸리면 0으로 리셋된다. '
  '[ADR 0017] 무차별 대입 완화용 — 학생 화면의 연동 폼이 코드 존재 여부를 무제한으로 확인하는 '
  'oracle이 되는 것을 막는다. 학생 본인 값이므로 본인 select 정책으로 자기 값을 볼 수 있어도 무해하다.';
comment on column public.profiles.school_link_locked_until is
  '[ADR 0017] 이 시각까지 link_school_account 호출이 전부 거부된다(rate_limited) — 이번 시도의 코드가 '
  '맞아도 마찬가지다(잠금 목적이 "정오답 판정"이 아니라 "시도 속도 제한"이라서). null이면 잠금 없음.';

-- =========================================================
-- 2. link_school_account() 재정의 — 잠금 검사 + 실패 카운트
--
-- [바뀐 부분] 기존 로직(already_linked 판정 → invite_codes 조회 → account_type/mentor_students 갱신)은
--   그대로다. 앞에 잠금 검사를 추가하고, invite_codes 조회가 실패/성공할 때 카운터를 갱신하는
--   update 문 두 줄만 늘었다.
-- [for update로 잠근 이유] 동시에 여러 요청이 같은 학생 행의 fail_count를 읽고 쓰면(레이스) 잠금
--   임계치를 놓칠 수 있다 — 다른 RPC들(cancel_my_participation 등)과 같은 패턴.
-- =========================================================
create or replace function public.link_school_account(p_invite text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student   uuid := auth.uid();
  v_invite    text := public.invite_normalize(p_invite);
  v_admin     uuid;
  v_prof      public.profiles%rowtype;
  v_fails     integer;
  v_max_fails constant integer := 5;
  v_cooldown  constant interval := interval '15 minutes';
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if public.is_admin() then
    -- 관리자에게는 소속 개념이 없다. 관리자가 다른 관리자의 담당이 되는 구조를 만들지 않는다.
    raise exception '학생만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  select * into v_prof from public.profiles where id = v_student for update;
  if not found then
    raise exception '프로필을 찾을 수 없습니다.' using errcode = '42501';
  end if;

  -- [ADR 0017 — 잠금 검사가 가장 먼저] 잠금 중이면 already_linked 판정도, invite_codes 조회도
  -- 하지 않는다 — 그 자체가 "지금 호출이 뭔가를 알아냈다"는 신호를 하나라도 더 주지 않기 위해서다.
  -- 연동된 학생은 애초에 프런트에서 이 폼 자체를 보여주지 않으므로(StudentMyPage isSchool 분기),
  -- "이미 연동된 학생이 잠긴 채로 already_linked를 못 보는" 경우는 정상 사용 경로에서 발생하지 않는다.
  if v_prof.school_link_locked_until is not null and now() < v_prof.school_link_locked_until then
    return jsonb_build_object(
      'ok', false, 'reason', 'rate_limited', 'retry_after', v_prof.school_link_locked_until
    );
  end if;

  -- [바뀐 부분 — ADR 0015] "이미 연동됨"을 account_type이 아니라 실제 매핑 존재로 판정한다.
  if exists (select 1 from public.mentor_students ms where ms.student_id = v_student) then
    return jsonb_build_object('ok', false, 'reason', 'already_linked');
  end if;

  select ic.admin_id into v_admin
    from public.invite_codes ic
   where ic.code = v_invite and ic.kind = 'school' and ic.is_active;

  if v_admin is null then
    -- [ADR 0017] 틀린 시도 — 실패 횟수를 늘리고, 임계치에 닿으면 잠근다(카운터는 동시에 0으로 리셋 —
    -- 잠금이 풀리는 시점부터 다시 5번을 새로 센다).
    v_fails := v_prof.school_link_fail_count + 1;
    if v_fails >= v_max_fails then
      update public.profiles
         set school_link_fail_count = 0,
             school_link_locked_until = now() + v_cooldown
       where id = v_student;
    else
      update public.profiles
         set school_link_fail_count = v_fails
       where id = v_student;
    end if;
    return jsonb_build_object('ok', false, 'reason', 'invalid_invite');
  end if;

  -- [ADR 0017] 성공 — 실패 기록을 지운다. 정상적으로 몇 번 오타를 내다 마지막에 맞힌 학생까지
  -- 벌하지 않는다(카운터의 목적은 무차별 대입이지, 서투른 손가락이 아니다).
  update public.profiles
     set account_type = 'school',     -- SET 목록은 이 컬럼들뿐이다(그대로 유지 — ADR 0008 결정 5)
         school_link_fail_count = 0,
         school_link_locked_until = null
   where id = v_student;

  insert into public.mentor_students (admin_id, student_id)
  values (v_admin, v_student)
  on conflict (admin_id, student_id) do nothing;

  return jsonb_build_object('ok', true, 'account_type', 'school');
end;
$$;

comment on function public.link_school_account(text) is
  '[ADR 0008 결정 5 + ADR 0015 + ADR 0017] 개인 계정 학생이 초대코드로 학교 계정이 되는 경로이자, '
  '담당이 해제된("추방된") 학교 계정 학생이 다시 연동되는 경로다. UPDATE SET 목록은 account_type/ '
  'school_link_fail_count/school_link_locked_until 뿐이라 points_*/role/code는 이 경로로 바뀔 수 없다. '
  '학생 id를 인자로 받지 않으므로 남을 남의 담당에 넣을 수 없다. "이미 연동됨" 판정은 mentor_students '
  '행 존재 여부다. [ADR 0017] 연속 5회 오답이면 15분 잠긴다(rate_limited) — 잠금 중엔 정답 코드를 '
  '넣어도 통과하지 않는다. 무차별 대입으로 관리자의 SCH- 코드를 전수 조사하는 경로를 늦춘다.';

revoke all on function public.link_school_account(text) from public;
grant execute on function public.link_school_account(text) to authenticated;

-- =========================================================
-- 적용 후 확인
--   1) 존재하지 않는 코드로 5번 연속 호출 -> 5번째부터 reason='rate_limited' (4번째까지는 invalid_invite)
--   2) 잠긴 상태에서 진짜 유효한 코드를 넣어도 rate_limited (정답이어도 안 뚫림)
--   3) 15분 경과 후(또는 school_link_locked_until을 과거로 수동 UPDATE) 재시도 -> 다시 정상 판정
--   4) 유효한 코드로 성공 -> school_link_fail_count=0, school_link_locked_until=null 로 리셋 확인
-- =========================================================
