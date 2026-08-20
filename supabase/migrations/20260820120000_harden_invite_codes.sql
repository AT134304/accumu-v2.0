-- Accumu v2 — 초대코드 경화 (ADR 0024)
--
-- [배경 — 2026-08-20 점검에서 나온 3건. 1번이 가장 심각하다]
--
--   (1) ★ 학교 초대코드가 **추측이 아니라 계산**으로 나온다.
--       코드 규칙이 'SCH-' || upper(substr(md5(관리자 uuid), 1, 4)) 였다. 입력이 관리자 uuid 하나뿐인
--       md5 라서, uuid 를 아는 사람은 무차별 대입 없이 **한 줄로 코드를 만들어낼 수 있다.**
--       그리고 그 uuid 는 공개돼 있었다 — 대표 사진의 공개 URL 이
--         https://<ref>.supabase.co/storage/v1/object/public/program-images/<관리자 uuid>/<파일>.webp
--       이고, image_url 은 학생 화면 카드가 실제로 읽는 필드(CARD_FIELDS)다. 즉 **사진이 붙은
--       프로그램을 하나라도 본 학생은 그 관리자의 학교 초대코드를 즉시 계산할 수 있었다.**
--       ADR 0017 의 link_school_account rate limit 은 이 경로를 전혀 막지 못한다 — 첫 시도가 맞는다.
--       >>> 결정론적 규칙을 폐기하고 **난수**로 바꾼다. generate_personal_code() 와 같은 패턴이다.
--
--   (2) 관리자 승격 코드가 'ADMIN-2026' 이라는 추측 가능한 리터럴이었고, 그 값이 git 에도
--       (마이그레이션·ADR 0017·SignupPage placeholder) 남아 있었다. 이 코드 하나가 뚫리면
--       role=admin 계정이 생기고, 그 순간 포인트 지급 RPC 가 열린다 — 앱에서 가장 비싼 사고다.
--       >>> 난수 12자리로 교체한다. 새 값은 이 파일에 적히지 않는다(아래 4절 "확인 방법" 참고).
--
--   (3) check_signup_availability() 가 **익명 + 무제한**으로 관리자 초대코드의 정오답을 알려줬다.
--       ADR 0017 이 이 함수를 유예한 근거는 "계정 생성 없이는 재시도가 안 된다" 였는데, 이 함수는
--       애초에 계정 없이 호출된다 — 그 근거가 이 함수에는 맞지 않았다.
--       >>> 관리자 분기를 이 함수에서 **제거**한다. 최종 판정자인 handle_new_user() 는 그대로 두므로
--           기능은 유지되고(가입 시도 시 같은 문구로 거부된다), 프런트도 그 경로를 이미 처리하고 있다
--           (authService.js: /초대코드/ 매칭 -> invalid_admin_invite). 판정 1회에 signUp POST 1회가
--           들며 Supabase Auth 의 기본 요청 제한을 타므로 값싼 oracle 이 아니게 된다.
--
-- [범위] invite_codes 의 값과 생성 규칙, handle_new_user(), check_signup_availability() 만 고친다.
--   기존 정책·QR·포인트·정산·알림은 한 줄도 건드리지 않는다.
--
-- [실행 순서] 20260814200000 이후. 이 파일 하나만 실행하면 된다.
-- [재실행] 안전하지 않다 — 재실행하면 코드가 **다시 새 난수로 바뀐다**(결정론적 규칙을 버린 대가다).
--   한 번만 적용하고, 바뀐 값은 아래 4절로 확인할 것.

-- =========================================================
-- 1. 학교 초대코드 생성의 유일한 소유자
--
-- [함수로 뽑아내는 이유] 이 규칙은 지금까지 마이그레이션 4개에 리터럴로 복사돼 있었다
--   (20260731120000 / 20260731140000 / 20260814160000 / 20260814180000). 규칙이 여러 벌이면
--   다음에 트리거를 다시 정의하는 사람이 옛 규칙을 그대로 옮겨 적는다 — 실제로 4번 그렇게 됐다.
--   >>> 앞으로 handle_new_user() 를 재정의할 때 이 함수를 호출할 것. 리터럴을 다시 쓰지 말 것.
--
-- [난수인 이유] 위 배경 (1). 입력이 공개값 하나뿐인 해시는 "비밀"이 아니라 "인코딩"이다.
--   salt 를 섞는 방법도 있지만 salt 가 이 파일(=git)에 남으면 같은 문제가 그대로 돌아온다.
-- [길이 8자리] 16^8 ≈ 43억. 이제 무차별 대입은 ADR 0017 의 잠금 없이도 비현실적이다
--   (그 잠금은 그대로 유지한다 — 방어선을 줄이지 않는다).
-- [충돌] code 가 unique 라 만에 하나 겹치면 다시 뽑는다. generate_personal_code() 와 같은 구조.
-- =========================================================
create or replace function public.new_school_invite_code()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  for i in 1..10 loop
    v_code := 'SCH-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    if not exists (select 1 from public.invite_codes ic where ic.code = v_code) then
      return v_code;
    end if;
  end loop;
  -- 조용히 중복 코드를 만들지 않고 실패시킨다(fail-closed). 이 예외는 가입 트랜잭션을 롤백한다.
  raise exception '학교 초대코드를 발급하지 못했습니다.' using errcode = '55000';
end;
$$;

comment on function public.new_school_invite_code() is
  '[2026-08-20] 학교 초대코드(SCH-XXXXXXXX) 발급. **난수**이며 관리자 id 에서 유도되지 않는다. '
  '옛 규칙 md5(관리자 uuid) 앞 4자는 폐기됐다 — 그 uuid 가 대표 사진 공개 URL 경로에 그대로 들어 있어 '
  '학생이 코드를 계산해낼 수 있었다. >>> 이 함수가 규칙의 유일한 소유자다. handle_new_user() 를 '
  '다시 정의할 때 리터럴을 복사하지 말고 이 함수를 호출할 것.';

-- =========================================================
-- 2. 기존 코드 교체 — 옛 규칙으로 만들어진 값은 전부 이미 유출된 것으로 간주한다
--
-- [update 로 도는 이유] 관리자마다 새 난수를 뽑아야 해서 한 문장으로는 안 된다.
-- [담당 관계는 그대로다] mentor_students 는 가입/연동 시점에 이미 만들어진 행이라 코드가 바뀌어도
--   영향받지 않는다. 바뀌는 것은 "앞으로 이 코드를 입력해야 연동된다"는 값 하나뿐이다.
-- =========================================================
do $$
declare
  r record;
begin
  for r in select id from public.invite_codes where kind = 'school' loop
    update public.invite_codes
       set code = public.new_school_invite_code()
     where id = r.id;
  end loop;
end $$;

-- 관리자 승격 코드 — 추측 가능한 리터럴('ADMIN-2026')을 난수 12자리로 바꾼다.
--   앱 전체에 kind='admin' 행은 1개다(ADR 0008). 여러 개면 전부 새 값을 받는다.
do $$
declare
  r record;
  v_code text;
begin
  for r in select id from public.invite_codes where kind = 'admin' loop
    loop
      v_code := 'ADMIN-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
      exit when not exists (select 1 from public.invite_codes ic where ic.code = v_code);
    end loop;
    update public.invite_codes set code = v_code where id = r.id;
  end loop;
end $$;

-- =========================================================
-- 3. handle_new_user() 재정의
--
-- [바뀐 것은 정확히 한 줄이다] 마지막 invite_codes insert 의 리터럴 규칙 ->
--   public.new_school_invite_code() 호출. 나머지 본문(진입 4가지 분기, school 필수 검사,
--   소셜=학생·개인 고정, mentor_students 연결)은 20260814180000 과 **동일**하다.
--   >>> 이 함수를 다음에 또 재정의한다면 여기(최신본)를 복사하고 바꿀 곳만 바꿀 것.
-- =========================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_provider text  := coalesce(new.raw_app_meta_data->>'provider', 'email');
  v_code     text  := trim(coalesce(v_meta->>'code', ''));
  v_name     text  := trim(coalesce(v_meta->>'name', ''));
  v_invite   text  := public.invite_normalize(v_meta->>'invite');
  -- [2026-08-14 재변경] 관리자와 **학교 계정 학생** 둘 다 직접 입력한다.
  --   개인 계정·소셜은 소속이 없으므로 아래 분기에서 NULL 로 지운다.
  v_school   text  := nullif(btrim(coalesce(v_meta->>'school', '')), '');
  v_role     public.user_role;
  v_account  public.account_type;
  v_track    public.career_track;
  v_admin    uuid;
begin
  begin
    v_track := nullif(v_meta->>'career_interest', '')::public.career_track;
  exception when others then
    v_track := null;
  end;

  -- (b) 소셜 로그인 — 학생·개인 고정. 초대코드도 role 도 school 도 읽지 않는다.
  if v_provider <> 'email' then
    if v_name = '' then
      v_name := trim(coalesce(
        v_meta->>'full_name',
        v_meta->>'name',
        v_meta->>'user_name',
        v_meta->>'preferred_username',
        ''
      ));
    end if;
    if v_name = '' then
      v_name := '이름 미설정';
    end if;

    insert into public.profiles (id, role, code, name, career_interest, account_type)
    values (new.id, 'student', public.generate_personal_code(), v_name, null, 'personal');
    return new;
  end if;

  -- (a) 시딩 경로: metadata 가 비어 있으면 관여하지 않는다.
  if v_code = '' and v_name = '' then
    return new;
  end if;

  -- (c) 개인 이메일 가입: 학번도 소속도 없다.
  if v_code = '' then
    insert into public.profiles (id, role, code, name, career_interest, account_type)
    values (
      new.id,
      'student',
      public.generate_personal_code(),
      v_name,
      nullif(v_meta->>'career_interest', '')::public.career_track,
      'personal'
    );
    return new;
  end if;

  -- (d) 학교 학생 / 관리자 가입
  if coalesce(v_meta->>'role', 'student') = 'admin' then
    if v_invite is null
       or not exists (
         select 1 from public.invite_codes ic
          where ic.code = v_invite and ic.kind = 'admin' and ic.is_active
       ) then
      raise exception '관리자 초대코드가 올바르지 않습니다.' using errcode = '22023';
    end if;
    if v_school is null then
      raise exception '학교 이름을 입력해주세요.' using errcode = '22023';
    end if;
    v_role := 'admin';
    v_account := null;
  else
    v_role := 'student';
    if v_invite is not null then
      select ic.admin_id into v_admin
        from public.invite_codes ic
       where ic.code = v_invite and ic.kind = 'school' and ic.is_active;
      if v_admin is null then
        raise exception '학교 초대코드가 올바르지 않습니다.' using errcode = '22023';
      end if;
      v_account := 'school';
      -- [2026-08-14 재변경] 학교 계정 학생은 자기 학교를 직접 넣는다. 로그인 대조 항목이므로
      --   비어 있으면 그 검사가 조용히 없는 계정이 된다 — 프런트가 이미 막지만 여기서도 막는다.
      --   >>> 같은 학교의 관리자가 있어야 한다는 조건은 **없다**. 초대코드의 주인이 어느 학교든
      --   >>> 학생이 적은 학교가 그 학생의 학교다(케빈 결정 2026-08-14).
      if v_school is null then
        raise exception '학교 이름을 입력해주세요.' using errcode = '22023';
      end if;
    else
      v_account := 'personal';
      v_school := null; -- 소속이 없다. 학생이 실어 보내도 저장하지 않는다.
    end if;
  end if;

  -- [중복처럼 보이지만 원본 그대로다] 위 begin 직후에 이미 같은 계산을 한다. 결과가 같은
  --   재계산이라 지워도 동작은 같지만, 이 마이그레이션은 **초대코드 한 줄만** 바꾸는 것이
  --   목적이라 나머지를 건드리지 않는다(재정의본을 원본과 그대로 대조할 수 있어야 한다).
  --   >>> 정리하려면 보안 변경이 아닌 별도 커밋에서 할 것.
  begin
    v_track := nullif(v_meta->>'career_interest', '')::public.career_track;
  exception when others then
    v_track := null;
  end;

  insert into public.profiles (id, role, code, name, career_interest, account_type, school)
  values (new.id, v_role, v_code, v_name, v_track, v_account, v_school);

  if v_admin is not null then
    insert into public.mentor_students (admin_id, student_id)
    values (v_admin, new.id)
    on conflict (admin_id, student_id) do nothing;
  end if;

  if v_role = 'admin' then
    -- [2026-08-20] 리터럴 규칙(md5 앞 4자) 폐기 — 1절 참고. 규칙의 소유자는 저 함수 하나다.
    insert into public.invite_codes (code, kind, admin_id)
    values (public.new_school_invite_code(), 'school', new.id)
    on conflict (code) do nothing;
  end if;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  '[ADR 0008 / 2026-08-20] 회원가입 시 auth.users insert 와 같은 트랜잭션에서 profiles 를 만든다. '
  '진입 4가지: 시딩(관여 안 함) / 소셜(학생·개인 고정) / 개인 이메일 가입 / 학교·관리자 가입. '
  '[소셜로는 관리자가 될 수 없다] 소셜 분기는 role 을 student 로 고정하며 metadata 의 role/invite 를 읽지 않는다. '
  '[school] 관리자와 학교 계정 학생이 각각 직접 입력한다(둘 다 필수). 개인·소셜 계정은 NULL. '
  '[초대코드 발급] new_school_invite_code() 를 호출한다 — 규칙을 여기에 리터럴로 다시 쓰지 말 것.';

-- =========================================================
-- 4. check_signup_availability() 재정의 — 관리자 분기 제거 (배경 (3))
--
-- [남는 것] 학번/관리자코드 중복(code_taken) + 학교 초대코드 유효성.
--   학교 코드는 이제 43억 공간의 난수라 정오답을 알려줘도 전수 조사가 성립하지 않고,
--   학생 가입 화면에서 "코드를 잘못 적었다"를 즉시 말해주는 UX 가치가 그대로 크다.
-- [사라지는 것] 관리자 초대코드 검사. p_invite 는 계속 받되 role='admin' 일 때는 보지 않는다
--   (인자 시그니처를 바꾸면 authService.checkSignupAvailability 호출부가 함께 깨진다 — 인자는 유지).
-- [기능 회귀 없음] 틀린 관리자 코드로 가입을 시도하면 handle_new_user() 가 같은 문구로 거부하고
--   가입 자체가 롤백된다. authService 가 그 문구를 invalid_admin_invite 로 이미 매핑하고 있다.
-- =========================================================
create or replace function public.check_signup_availability(
  p_role   text,
  p_code   text,
  p_invite text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code   text := upper(trim(coalesce(p_code, '')));
  v_invite text := public.invite_normalize(p_invite);
begin
  if v_code = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;

  -- code 는 대소문자를 구분하지 않고 중복으로 본다('adm-0001' 로 우회 가입할 수 없게).
  if exists (select 1 from public.profiles p where upper(p.code) = v_code) then
    return jsonb_build_object('ok', false, 'reason', 'code_taken');
  end if;

  -- [★ 관리자 분기 없음 — 2026-08-20] 익명이 무제한으로 관리자 코드의 정오답을 캐낼 수 있는
  --   경로였다. 판정은 handle_new_user() 가 한다(가입 시도 1회 = signUp POST 1회).
  --   >>> 여기에 admin 분기를 되살리지 말 것. 되살리는 순간 같은 oracle 이 돌아온다.
  if p_role <> 'admin' and v_invite is not null then
    -- 학생은 초대코드가 선택이다(개인 계정). 넣었다면 유효해야 한다.
    if not exists (
      select 1 from public.invite_codes ic
       where ic.code = v_invite and ic.kind = 'school' and ic.is_active
    ) then
      return jsonb_build_object('ok', false, 'reason', 'invalid_school_invite');
    end if;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.check_signup_availability(text, text, text) is
  '[ADR 0008 결정 4 / 2026-08-20 개정] 가입 폼 사전 검증. UX 계층이며 보안 경계가 아니다 — '
  '최종 판정은 handle_new_user() 트리거와 profiles.code unique 다. '
  '[관리자 초대코드는 검사하지 않는다] 익명·무제한 호출이라 관리자 코드의 oracle 이 됐었다. '
  '학교 코드만 검사한다(난수 43억 공간이라 전수 조사가 성립하지 않는다).';

revoke all on function public.check_signup_availability(text, text, text) from public;
grant execute on function public.check_signup_availability(text, text, text) to anon, authenticated;

-- =========================================================
-- 적용 후 확인 — ★ 새 코드는 이 파일에 없다. 아래 쿼리로 직접 읽을 것 (시연 전 필수)
--
--   select ic.kind, ic.code, p.code as admin_code, p.name
--     from public.invite_codes ic
--     left join public.profiles p on p.id = ic.admin_id
--    order by ic.kind, p.code;
--
--   기대: kind='school' 행이 관리자 수만큼, 전부 SCH- + 8자리 / kind='admin' 1행이 ADMIN- + 12자리.
--
--   회귀 확인 3가지:
--     1) select public.check_signup_availability('admin', 'ADM-0002', '아무거나');  -- {"ok": true} 여야 한다
--        (= 더 이상 관리자 코드의 정오답을 알려주지 않는다. 실제 거부는 가입 시도에서 일어난다)
--     2) select public.check_signup_availability('student', '20259999', 'SCH-XXXXXXXX'); -- 틀린 값이면 invalid_school_invite
--     3) 관리자 마이페이지 접속 -> "내 학교 초대코드"가 새 값으로 보이는지 (마스킹 길이도 함께 늘어난다)
-- =========================================================
