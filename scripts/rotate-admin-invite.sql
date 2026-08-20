-- Accumu v2 — 관리자 초대코드 재발급 (시연용)
--
-- 실행 방법: Supabase SQL Editor 에 이 파일 전체를 붙여넣고 실행한다.
--            **결과 그리드에 새 코드가 한 줄 뜬다.** 그 값을 옮겨 적어 두면 된다.
--
-- =============================================================================
-- [★ 왜 코드 값이 이 파일에 없나]
--   ADR 0024 결정 2: 관리자 승격 코드는 **git 에 남기지 않는다.** 예전 값 'ADMIN-2026' 이 마이그레이션과
--   ADR 과 회원가입 화면 placeholder 세 곳에 그대로 적혀 있었고, 그 코드 하나가 뚫리면 role=admin
--   계정이 생긴다 — 그 순간 포인트 지급 RPC 가 열린다(이 앱에서 가장 비싼 사고).
--
--   그래서 이 파일은 **값을 적어 두지 않고 만들어서 돌려준다.** 저장소에는 "만드는 방법"만 남고
--   값은 실행한 사람의 화면에만 뜬다.
--   >>> 실행 결과를 복사해 커밋하지 말 것. 슬랙·메모 앱에 붙여넣는 것도 같은 위험이다.
--
-- [★ 이 파일이 관리자 코드 규칙의 소유자다]
--   학교 코드는 new_school_invite_code() 가 소유한다(ADR 0024). 관리자 코드는 앱 안에서 만들어질
--   일이 없어서 함수를 두지 않고 이 스크립트가 유일한 발급 경로다.
--   >>> 다른 곳에 난수식을 복사하지 말 것. 갱신이 필요하면 이 파일을 다시 실행한다.
--
-- [문자셋 — 사람이 불러줄 수 있어야 한다]
--   '23456789ABCDEFGHIJKMNPQRSTUVWXYZ' (32자). 0·1·L 을 뺐다:
--     0 을 빼서 O 가 안전해지고, 1 을 빼서 I 가 안전해진다. L 은 I 와 헷갈려서 뺐다.
--   32^8 ≈ 1.1조. 전화로 불러 주거나 칠판에 적어도 틀리지 않는 길이·모양이면서 추측은 불가능하다.
--   (관리자 초대코드는 rate limit 이 없다 — check_signup_availability 에서 검사를 아예 뺐기 때문에
--    시도 1회에 signUp POST 1회가 들고 Supabase Auth 의 요청 제한을 탄다. ADR 0024 결정 3.)
--
-- [★ 시연이 끝나면 끄는 것을 잊지 말 것 — 아래 3번]
--   코드를 아는 사람은 누구나 관리자 계정을 만들 수 있다. 심사자에게 보여줬다면 시연 직후 끈다.
-- =============================================================================

-- =========================================================
-- 1. 새 코드 발급 (기존 admin 코드가 없으면 만든다)
-- =========================================================
insert into public.invite_codes (code, kind, admin_id, is_active)
select
  'ADMIN-' || (
    select string_agg(
      substr(
        '23456789ABCDEFGHIJKMNPQRSTUVWXYZ',
        1 + (('x' || substr(replace(gen_random_uuid()::text, '-', ''), i * 2 + 1, 2))::bit(8)::integer & 31),
        1
      ),
      '' order by i
    )
    from generate_series(0, 7) as i
  ),
  'admin',
  null,
  true
where not exists (select 1 from public.invite_codes where kind = 'admin');

-- =========================================================
-- 2. 기존 admin 코드를 새 난수로 교체 + 활성화
--
--    [returning 이 이 스크립트의 본체다] 값을 화면으로만 내보내는 유일한 수단이다.
--    앱 전체에 kind='admin' 행은 1개다(ADR 0008) — 여러 개면 전부 새 값을 받는다.
-- =========================================================
update public.invite_codes
   set code = 'ADMIN-' || (
         select string_agg(
           substr(
             '23456789ABCDEFGHIJKMNPQRSTUVWXYZ',
             1 + (('x' || substr(replace(gen_random_uuid()::text, '-', ''), i * 2 + 1, 2))::bit(8)::integer & 31),
             1
           ),
           '' order by i
         )
         from generate_series(0, 7) as i
       ),
       is_active = true
 where kind = 'admin'
returning code as "새 관리자 초대코드  (회원가입 > 관리자 탭에 입력)";

-- =========================================================
-- 3. 시연이 끝나면 — 코드를 끈다 (지우지 않는다)
--
--    [지우지 않고 끄는 이유] handle_new_user() 는 is_active = true 인 행만 인정한다. 끄면 그 코드로
--    가입이 즉시 막히고, 다시 켜거나 이 스크립트를 다시 실행하면 언제든 되살릴 수 있다.
--    행을 지우면 "관리자 코드가 원래 없는 프로젝트"처럼 보여서 다음에 읽는 사람이 혼란스럽다.
--
--    아래 한 줄을 따로 실행할 것:
--
--      update public.invite_codes set is_active = false where kind = 'admin';
--
--    [학교 코드(kind='school')는 건드리지 말 것] 그걸 끄면 학생이 담당 관리자에게 연동될 수 없다.
-- =========================================================

-- =========================================================
-- 적용 후 확인
--   select ic.kind, ic.code, ic.is_active, p.code as admin_code, p.name
--     from public.invite_codes ic
--     left join public.profiles p on p.id = ic.admin_id
--    order by ic.kind, p.code;
--
--   기대: kind='admin' 1행이 ADMIN- + 8자리, is_active = true.
--         kind='school' 은 관리자 수만큼, SCH- + 8자리 (이 스크립트가 건드리지 않는다).
-- =========================================================
