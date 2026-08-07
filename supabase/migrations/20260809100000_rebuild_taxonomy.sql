-- Accumu v2 — 활동 유형 8종 → 4종, 진로 계열 5종 → 7종 (ADR 0014)
-- 출처: docs/adr/0014-taxonomy-rebuild.md
--
-- [왜 바꾸는가]
--   활동 유형 8종은 한 enum 안에 축이 두 개(교내/교외 = 어디서 + 방과후/동아리/대회 = 무엇을) 눌려 있었다.
--   그 결과 8종 중 4종이 중복이었고(대회 hdc/edc, 기타 het/eet), 정작 이 앱의 주제인 "진로 체험" 칸이
--   없어서 시드의 진로 박람회·전공 체험이 전부 '기타'로 갔다.
--
-- [케빈 결정 — 2026-08-08/09]
--   1. 방과후 폐지: 참여에 비용이 드는 활동을 포인트로 보상하면 "돈 내고 포인트 사는" 구조가 된다.
--   2. 교내/교외 축 폐지: 방과후가 빠지면 교내에 동아리·자율만 남아 축으로서 의미가 없다.
--   3. 대회는 교내/교외 구분 없이 전부 받는다(상장=이중 보상 논리는 인지하되 포트폴리오 축으로 유지).
--   4. 봉사활동은 독립 카테고리로 둔다 — 생기부 독립 항목이고 아카이브에서 따로 세어져야 한다.
--   5. 박람회는 '대회'가 아니라 '진로 체험'이다 — 학생이 하는 행동이 경쟁이 아니라 탐색이다.
--   6. 진로 계열은 7계열로 재편: it 을 공학에 흡수하고 사회·교육 / 의약·보건을 채운다.
--
-- [★ enum 값 추가가 아니라 타입 교체다]
--   Postgres enum 은 값을 제거·개명할 수 없다. 그래서 새 타입을 만들고 컬럼을 옮긴 뒤 옛 타입을 지운다.
--   >>> 20260808100000 의 "enum 확장은 단독 마이그레이션" 규율은 `alter type ... add value` 에만 해당한다.
--       여기처럼 새 타입을 만들어 같은 트랜잭션에서 쓰는 것은 55P04 제약과 무관하다.
--
-- [★ career_track 은 컬럼 두 개가 공유한다 — ADR 0003 결정 3]
--   programs.career_track 과 profiles.career_interest 가 같은 타입이다. 한쪽만 옮기면 타입을 지울 수 없다.
--   또 set_career_interest(p_track public.career_track) 이 타입에 의존하므로 먼저 드롭하고 나중에 되만든다.
--
-- [재실행 안전] 아래 case 문에 신규 값의 항등 매핑이 들어 있다. 이미 새 타입으로 옮긴 DB 에서 다시 실행하면
--   같은 값으로 한 번 더 옮길 뿐 데이터가 뭉개지지 않는다.
--   >>> case 에서 항등 매핑 줄을 지우지 말 것. 지우면 재실행이 모든 행을 else 로 몰아 파괴적으로 바뀐다.

-- =========================================================
-- 0. 타입에 의존하는 함수 먼저 제거 (마지막 절에서 되만든다)
-- =========================================================
drop function if exists public.set_career_interest(public.career_track);

-- =========================================================
-- 1. program_category — 8종 → 4종
--
--   school     교내 활동      동아리 · 자율활동 · 학생회 · 또래멘토링
--   contest    대회·공모전    교내외 모든 대회
--   volunteer  봉사활동       주최 무관 모든 봉사
--   career     진로 체험      박람회 · 학과탐방 · 멘토링 · 기업/대학/기관 프로그램 · 공유학교 · 온라인학교
--
--   [기타 칸이 없다] 애매하면 갈 곳이 있다는 것 자체가 분류를 무너뜨린다. 시드 17건이 기타 없이 전부 들어간다.
--   [주최(기업/대학/국가기관/공유학교/온라인학교)는 카테고리가 아니다] programs.org 텍스트가 이미 화면에
--     "삼성전자"·"○○대학교"·"경기도교육청 공유학교" 로 찍어 준다. 축을 하나 더 만들 이유가 없다.
--
--   [hbk(방과후) 매핑에 대하여] 방과후는 폐지 결정이라 시드에서 빠진다. 그러나 원격 DB 에 이미 있는 행을
--     이 마이그레이션이 지우지는 않는다 — 참여·포인트가 딸려 있을 수 있고, 데이터 삭제는 마이그레이션이
--     조용히 할 일이 아니다. 캐스팅 실패를 막기 위해 career 로 옮겨두고, 정리는 아래 안내대로 수동으로 한다.
-- =========================================================
do $$ begin
  create type public.program_category_v2 as enum ('school', 'contest', 'volunteer', 'career');
exception
  when duplicate_object then null;
end $$;

alter table public.programs
  alter column category type public.program_category_v2
  using (
    case category::text
      -- 구 8종
      when 'hdo' then 'school'      -- 교내 동아리
      when 'het' then 'school'      -- 교내 기타(또래멘토링·학생자치회 → 자율활동)
      when 'hdc' then 'contest'     -- 교내 대회
      when 'edc' then 'contest'     -- 교외 대회
      when 'evo' then 'volunteer'   -- 봉사활동
      when 'ecp' then 'career'      -- 기업·국가기관
      when 'eet' then 'career'      -- 교외 기타(전공 체험·진로 박람회)
      when 'hbk' then 'career'      -- 방과후(폐지 — 위 주석 참고)
      -- 신규 4종 항등 매핑 (재실행 안전 — 지우지 말 것)
      when 'school' then 'school'
      when 'contest' then 'contest'
      when 'volunteer' then 'volunteer'
      when 'career' then 'career'
    end
  )::public.program_category_v2;

drop type public.program_category;
alter type public.program_category_v2 rename to program_category;

comment on type public.program_category is
  '활동 유형 4종(ADR 0014). school=교내 활동, contest=대회·공모전, volunteer=봉사활동, career=진로 체험. '
  '[교내/교외 축은 폐지됐다] 2026-08-09 이전에는 8종이었고 group(교내/교외)이 프런트 CAT 맵에 있었다. '
  '한 enum 에 "어디서"와 "무엇을" 두 축이 눌려 있어 대회·기타가 각각 두 키로 갈렸다. '
  '[주최는 카테고리가 아니다] 기업/대학/국가기관/공유학교/온라인학교 구분은 programs.org 텍스트가 담당한다. '
  '[기타 칸을 만들지 말 것] 애매한 것이 갈 곳이 생기면 그리로 몰려 분류가 다시 무너진다. '
  '표시명·색상·아이콘은 DB 가 아니라 프런트엔드 CAT 맵이 소유한다.';

-- =========================================================
-- 2. career_track — 5종 → 7종
--
--   hum 인문·어학 / soc 사회·교육 / biz 상경·경영 / sci 자연과학 / eng 공학·IT / med 의약·보건 / art 예술·체육
--
--   [it → eng 흡수] IT·소프트웨어는 공학의 부분집합인데 동급으로 놓여 있어 "AI 로봇 대회"가 어디인지
--     애매했다. 공학·IT 한 칸으로 합친다.
--   [soc·med 신설] 교육(사범) 지망은 갈 곳이 없었고, 의약·보건은 고교생 진로 희망 최상위권인데 빠져 있어
--     sci 로 억지로 들어갔다.
--   [biz 는 남긴다] 대학 계열 구분상 상경은 사회계열 안이지만, 지망 규모가 커서 별도 축이 실용적이다.
--
--   ★ 두 컬럼(programs.career_track, profiles.career_interest)을 같은 트랜잭션에서 함께 옮긴다.
--     한쪽만 옮기면 옛 타입을 drop 할 수 없고, 값 공간 일치 보장(ADR 0003 결정 3)도 깨진다.
-- =========================================================
do $$ begin
  create type public.career_track_v2 as enum ('hum', 'soc', 'biz', 'sci', 'eng', 'med', 'art');
exception
  when duplicate_object then null;
end $$;

alter table public.programs
  alter column career_track type public.career_track_v2
  using (
    case career_track::text
      when 'it'  then 'eng'   -- IT·소프트웨어 → 공학·IT
      when 'sci' then 'sci'
      when 'hum' then 'hum'
      when 'biz' then 'biz'
      when 'art' then 'art'
      -- 신규 값 항등 매핑 (재실행 안전 — 지우지 말 것)
      when 'soc' then 'soc'
      when 'eng' then 'eng'
      when 'med' then 'med'
    end
  )::public.career_track_v2;

-- NULL 은 어느 when 에도 걸리지 않아 NULL 로 남는다 — 계열 미선택(학생) / 계열 개념 없음(관리자) 둘 다
-- 정상 도메인 상태다(profiles.career_interest comment).
alter table public.profiles
  alter column career_interest type public.career_track_v2
  using (
    case career_interest::text
      when 'it'  then 'eng'
      when 'sci' then 'sci'
      when 'hum' then 'hum'
      when 'biz' then 'biz'
      when 'art' then 'art'
      when 'soc' then 'soc'
      when 'eng' then 'eng'
      when 'med' then 'med'
    end
  )::public.career_track_v2;

drop type public.career_track;
alter type public.career_track_v2 rename to career_track;

comment on type public.career_track is
  '진로 계열 7종(ADR 0014). hum=인문·어학, soc=사회·교육, biz=상경·경영, sci=자연과학, eng=공학·IT, '
  'med=의약·보건, art=예술·체육. 2026-08-09 이전에는 5종(sci/it/hum/biz/art)이었다 — it 은 eng 에 흡수됐고 '
  'soc·med 가 신설됐다. '
  'programs.career_track 과 profiles.career_interest 가 이 하나의 타입을 공유한다(ADR 0003 결정 3) — '
  '추천 매칭 두 축의 값 공간 일치를 DB 가 구조적으로 보장한다. 둘 중 하나만 타입을 바꾸지 말 것. '
  '표시명/색상은 프런트엔드 TRACK 맵이 소유한다.';

-- =========================================================
-- 3. set_career_interest() 되만들기 (0번 절에서 드롭한 함수)
--
--   본문은 20260730140000 그대로다. 바뀐 것은 인자 타입이 가리키는 enum 의 내용뿐이며,
--   "인자가 enum 이라 목록 밖의 값은 캐스팅 단계(22P02)에서 걸러진다"는 성질이 7종에도 그대로 적용된다.
-- =========================================================
create or replace function public.set_career_interest(p_track public.career_track)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
  v_track   public.career_track;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if public.is_admin() then
    -- role=admin 은 계열 개념 자체가 없다(profiles.career_interest comment). 관리자가 학생의 계열을 바꾸는
    -- 경로도 만들지 않는다 — 관리자 기능 3종(CLAUDE.md 2장 6번) 밖이다.
    raise exception '학생만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  update public.profiles
     set career_interest = p_track          -- SET 목록은 이 한 컬럼뿐이다. 여기가 컬럼 경계다.
   where id = v_student
  returning career_interest into v_track;

  if not found then
    raise exception '프로필을 찾을 수 없습니다.' using errcode = '42501';
  end if;

  return jsonb_build_object('ok', true, 'career_interest', v_track);
end;
$$;

comment on function public.set_career_interest(public.career_track) is
  '[ADR 0007 / 타입은 ADR 0014] 학생 본인의 관심 진로 계열 저장/해제(p_track => null 이 해제). '
  'profiles 에 update 정책을 열지 않고 이 함수 하나로만 연다 — 정책을 열면(설령 컬럼 grant 를 함께 걸어도) '
  '보안 성질이 grant 한 줄에 얹혀 fail-open 이 된다(ADR 0007 결정 4-3). '
  'UPDATE SET 목록이 career_interest 하나뿐이라는 것이 컬럼 경계의 전부다. 인자 타입이 enum 이라 '
  '7종/NULL 외의 값은 캐스팅 단계(22P02)에서 걸러진다. 관리자는 호출할 수 없다.';

revoke all on function public.set_career_interest(public.career_track) from public;
grant execute on function public.set_career_interest(public.career_track) to authenticated;

-- =========================================================
-- 4. 방과후 프로그램 정리 (수동 — 이 마이그레이션은 지우지 않는다)
--
--   케빈 결정: 방과후 시드 3건("파이썬 코딩 기초 방과후", "AI·데이터 기초 방과후", "수학 심화 탐구반")은
--   삭제한다. scripts/seed-programs.mjs 에서는 이미 빠졌다.
--   원격 DB 의 기존 행은 참여·포인트가 딸려 있을 수 있어 마이그레이션이 조용히 지우지 않는다.
--   깨끗하게 지우려면 service_role 로 아래를 실행할 것(참여 행은 on delete cascade 로 함께 사라진다):
--
--     delete from public.programs
--      where title in ('파이썬 코딩 기초 방과후', 'AI·데이터 기초 방과후', '수학 심화 탐구반');
--
--   >>> 포인트가 이미 지급된 참여가 있었다면 profiles.points_* 는 그대로 남는다(원장만 cascade 로 사라진다).
--       완전 초기화는 기존 시연 리셋 절차를 따를 것.
-- =========================================================
