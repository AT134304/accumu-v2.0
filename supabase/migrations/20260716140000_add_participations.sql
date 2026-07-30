-- Accumu v2 — 마이그레이션: participations 테이블 (앱 최초의 "쓰기" 경로)
-- 출처: docs/db/schema.sql 4번 절 (단일 스키마 소스), docs/adr/0004-participations-schema-and-first-write-policy.md
-- 기능: 프로그램 선택 화면 + 참여 신청 팝업 — docs/specs/student-programs.md
--
-- 범위: 참여 신청(status=applied 인 행 생성)에 필요한 것만 포함한다.
--   0) enum 1종: participation_status
--   1) participations 테이블 + RLS 정책 2개 (participations_select_own, participations_insert_own)
-- 기존 테이블 변경 없음 — ADR 0004 의 신규분은 participations 뿐이다(profiles/programs 는 건드리지 않는다).
-- CLAUDE.md 5장의 나머지 테이블(point_transactions, reviews, notifications)은
-- 해당 기능이 architect-agent를 거칠 때 별도 마이그레이션으로 추가한다.
-- 임의로 없는 필드/정책/인덱스를 추가하지 않는다 — docs/db/schema.sql, ADR 0004 그대로 반영.
--
-- [이 마이그레이션이 앱 최초의 쓰기 경로를 연다]
--   이전까지 RLS 정책은 select 2개(profiles_select_own, programs_select_published)뿐이었고
--   insert/update/delete 는 전 테이블 0개였다(= 앱은 읽기 전용이었다). 아래 participations_insert_own 의
--   with check 6절이 이 파일에서 가장 조심해서 읽어야 할 블록이다. 지금은 포인트 지급 로직이 없어 그 절들이
--   무의미해 보이지만, 다음 스펙(QR 이중 인증)에서 포인트 지급이 붙는 순간 느슨한 insert 정책은 그대로
--   부정 적립 경로가 된다. 이 마이그레이션은 그 문을 "지금" 닫는다 (ADR 0004 배경).
--
-- [실행 순서] 20260709120000 -> 20260716120000 -> 이 마이그레이션 -> seed-accounts.mjs -> seed-programs.mjs
--   - participations.student_id 가 profiles(20260709120000)를, program_id 가 programs(20260716120000)를
--     참조하므로 두 마이그레이션이 반드시 먼저 적용되어 있어야 한다.
--   - participations 자체의 시드는 없다 — 신청은 앱에서 학생이 직접 만든다(ADR 0004: 가짜 데이터를
--     하드코딩하지 않는다). 따라서 시딩 스크립트와의 선후 관계는 없지만, 학생이 신청할 프로그램이
--     존재해야 하므로 시연 전에 seed-programs.mjs 는 실행되어 있어야 한다.
--
-- [재실행] 아래 create policy 는 drop policy if exists 가드가 없어 두 번째 적용 시
--   "policy already exists" 로 실패한다 (기존 마이그레이션 2개와 동일한 관례. 1회 적용 전제).

-- =========================================================
-- 0. 확장 / 타입
-- =========================================================
create extension if not exists pgcrypto; -- gen_random_uuid() 용. Supabase 프로젝트는 보통 기본 활성화되어 있음.

-- 한 학생의 참여 진행도 3종. ADR 0004.
--
-- [program_status 와 혼동 금지 — 이름만 비슷하고 개념이 완전히 다르다]
--   programs.status (program_status)       = 프로그램의 모집 상태. 정적 필드. join 매핑은 프런트 STATUS 맵 소유.
--   participations.status (아래 타입)      = 한 학생의 참여 진행도. 상태 전이는 DB/서버만 수행한다
--                                            (QR 토큰 검증 결과로만 바뀐다 — 학생이 직접 못 쓴다. 아래 RLS 참고).
--
-- [값 3종을 지금 정의하는 근거] CLAUDE.md 6장이 QR 흐름을 이미 확정했고 상태 지점이 기계적으로 도출된다:
--   (1) 신청 -> (2) 입장 인증 시 entry_at 기록 -> (3) 퇴장 인증 시 exit_at 기록 + 포인트 지급.
--   entry_at/exit_at 컬럼을 이번에 만드는 결정과 짝을 이룬다(컬럼이 존재한다 = 그 상태가 도메인에 존재한다).
--   applied 1종만 만들면 아래 RLS 의 `status = 'applied'` 술어가 자명해 보여 삭제 유혹이 생기는데,
--   그 술어는 QR 스펙의 부정 적립을 막는 자물쇠다 (ADR 0004 1번).
--
-- [이번 스코프에서 생성되는 값은 'applied' 하나뿐이다] entered/completed 는 QR 스펙 몫.
-- cancelled/no_show 는 넣지 않는다 — 확정 G-1(신청 취소 스코프 아님)이고 CLAUDE.md 6장에도 근거가 없다.
do $$ begin
  create type participation_status as enum ('applied', 'entered', 'completed');
exception
  when duplicate_object then null;
end $$;

comment on type participation_status is
  'applied=신청함(행 생성 시점), entered=입장 인증 완료(entry_at 기록됨), completed=퇴장 인증 완료(=참여 완료, 포인트 지급 대상). '
  '[주의] programs.status(program_status)와 다른 개념이다 — 저쪽은 프로그램의 모집 상태, 이쪽은 한 학생의 참여 진행도. '
  '이번 스코프(프로그램 선택+참여 신청)에서는 applied 만 생성된다. entered/completed 로의 전이는 QR 이중 인증 스펙 몫이며 '
  '학생이 직접 쓸 수 없다 (participations_insert_own 의 with check + update 정책 0개).';

-- =========================================================
-- 1. participations
--    학생의 프로그램 신청/참여 행 (CLAUDE.md 5장). 이후 QR 인증·포인트·아카이브·만족도 평가가
--    전부 이 행 위에 쌓인다.
--    ADR 0004 / docs/specs/student-programs.md
-- =========================================================
create table if not exists public.participations (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.profiles(id) on delete cascade,
  program_id   uuid not null references public.programs(id) on delete cascade,
  status       participation_status not null default 'applied',

  -- [아래 4개 컬럼은 QR 이중 인증 스펙(다음) 몫이라 이번 스코프에서 값이 절대 채워지지 않는다.]
  --   그럼에도 지금 만드는 이유는 "안 쓰지만 미리 만들어두면 편해서"가 아니다:
  --   RLS with check 는 행 단위 술어라 "존재하지 않는 컬럼"을 미리 금지할 수 없다. 이 컬럼들을 QR 스펙에서
  --   추가하면 그 시점의 participations_insert_own 은 새 컬럼을 언급하지 않으므로, 학생이 entry_at 을
  --   채우거나 토큰을 심어 insert 하는 경로가 조용히 열린다(= QR 이중 인증 우회 = 부정 적립).
  --   지금 컬럼을 만들고 아래 정책에 "... is null" 을 박아두면 그 구멍이 애초에 생기지 않는다.
  --   즉 이 컬럼들은 이번 스펙의 보안 요구사항(스펙 이슈 1)을 성립시키는 전제다. ADR 0004 3번.
  entry_at     timestamptz,                          -- 입장 인증 시각. QR 스캔 성공 시에만 서버가 기록한다.
  exit_at      timestamptz,                          -- 퇴장 인증 시각. 기록 시 포인트 지급 + 만족도 평가 노출(CLAUDE.md 6장 3번).
  entry_token  text,                                 -- [주의] 형식 미정이라 text. 아래 comment 참고.
  exit_token   text,

  created_at   timestamptz not null default now(),   -- 신청 시각. ADR 0002/0003 전례(전 테이블에 존재) + 참여 이력의 기본 축.

  -- [중복 신청 차단 — 클라이언트 방어만으론 새로고침/두 탭/개발자도구에서 뚫린다]
  --   인수 조건이 "DB 제약으로도 막힌다"를 명시했다. 위반 시 23505 -> PostgREST HTTP 409.
  --   status 무관하게 (학생, 프로그램) 쌍당 1행. 확정 G-1(신청 취소 스코프 아님)이라 "취소 후 재신청" 충돌 없음.
  unique (student_id, program_id)
);

comment on table public.participations is
  '학생의 프로그램 신청/참여 행. 이번 스코프(프로그램 선택 + 참여 신청 팝업)에서는 status=applied 인 행이 생성되는 것까지만 동작한다. '
  'QR 입·퇴장 인증 / 포인트 지급 / 만족도 평가는 다음 스펙이며, 이 테이블의 정책은 그것들이 붙었을 때 뚫리지 않도록 지금 봉인해 둔 것이다 (ADR 0004). '
  '[시연 리셋] delete from public.participations;  (service_role 로 실행 — 학생/관리자 키로는 delete 정책이 0개라 불가능하다.)';
comment on column public.participations.status is
  '한 학생의 참여 진행도. [주의] programs.status 와 다른 개념이다(저쪽은 프로그램의 모집 상태). '
  '학생은 이 값을 applied 로만 insert 할 수 있고(participations_insert_own 의 with check), update 정책이 0개라 이후 변경도 불가능하다. '
  'entered/completed 로의 전이는 QR 토큰 검증을 통과한 서버 경로만 수행한다 (CLAUDE.md 2장 5번: QR은 부정 참여 방지 장치이므로 단순화하지 않는다).';
comment on column public.participations.entry_token is
  'QR 1회용 토큰. [형식 미정 -> text] career_track 등 값 집합이 확정된 것은 enum 으로 좁혔지만(ADR 0003), 토큰 형식(랜덤 문자열/base64/uuid 등)은 '
  'QR 스펙의 결정사항이라 지금 uuid 로 좁히면 추측이 된다. unique 제약도 붙이지 않는다 — 재사용 방지 메커니즘 자체가 QR 스펙 설계다. '
  '만료(발급+30분)·사용 여부를 DB 컬럼(예: entry_token_expires_at)에 둘지 QR payload 에 둘지도 그때 결정한다 (CLAUDE.md 6장).';
comment on column public.participations.created_at is
  '신청 시각. [알려진 틈 — 수용] with check 가 이 컬럼을 검사하지 않으므로 학생이 값을 위조해 insert 할 수 있다. '
  '위조 대상이 본인 행의 신청 시각뿐이고 어떤 권한/포인트 결정에도 쓰이지 않아 수용한다(ADR 0004 "알려진 틈"). '
  'created_at = now() 술어는 트랜잭션 내 now() 안정성에 기대는 비자명한 비교라, 프런트가 값을 보내는 순간 원인 불명의 RLS 에러를 낸다 '
  '(방어 이득 없이 디버깅 비용만 발생). 대신 프런트는 insert 에 student_id/program_id 외 어떤 컬럼도 보내지 않는다. '
  '이 값이 포인트/권한 판단에 쓰이게 되면 봉인 방법을 재검토한다.';

-- [인덱스를 추가로 만들지 않는 이유 — 의도적 결정, ADR 0003 "주의 4"와 동일]
--   데모 데이터가 20행 규모라 PK 외 인덱스는 순수 노이즈다. 단 위 unique (student_id, program_id) 가 만드는
--   인덱스는 제약의 부산물이라 예외이며, 선두 컬럼이 student_id 라 participations_select_own 의
--   student_id = auth.uid() 조회도 그대로 커버한다. program_id 단독 인덱스를 추가하지 말 것.

alter table public.participations enable row level security;

-- [RLS 권한 경계] participations_select_own
--   대상 역할: authenticated
--   허용 행: student_id = auth.uid() 인 행만 select ("본인이 신청한 것"만)
--   불가능: 다른 학생의 신청 내역 조회 (학생↔학생 차단). 관리자도 볼 수 없다 — admin 정책이 없다(아래 참고).
--           anon(로그인하지 않은 키 보유자)의 모든 조회 — to authenticated + auth.uid() IS NULL 로 이중 차단.
--   용도: 카드/팝업의 "신청됨" 판정, 홈 추천에서 이미 신청한 프로그램 제외 (확정 D-1)
--
--   [부수 효과 — 절대 원칙이 UI 규율이 아니라 RLS 구조로도 성립한다]
--   학생에게는 본인 행만 보이므로 count(*) 를 던져도 자기 신청 수만 나온다. 즉 "N명이 신청했어요"류의
--   신청자 수 표시나 학생 단위 집계/랭킹은 애초에 데이터를 얻을 수 없다 (CLAUDE.md 2장 1번).
create policy "participations_select_own"
  on public.participations
  for select
  to authenticated
  using (student_id = auth.uid());

-- [RLS 권한 경계] participations_insert_own  <<< 이 앱 최초의 쓰기 정책. 각 절이 실제 공격 경로를 하나씩 막는다.
--   대상 역할: authenticated
--   허용 행: 아래 with check 6절을 전부 만족하는 행만 insert
--   불가능(= 각 절이 막는 것):
--     1) student_id = auth.uid()          -> 남의 이름으로 신청 (student_id 위조).                       위반 시 42501/403
--     2) status = 'applied'               -> 스스로 "참여 완료" 상태로 insert.                            위반 시 42501/403
--     3) entry_at is null, exit_at is null-> 입·퇴장 시각을 직접 기록해 QR 인증을 건너뛰기.               위반 시 42501/403
--     4) entry_token/exit_token is null   -> 자기가 아는 토큰을 미리 심어두고 그 QR 을 생성하기.          위반 시 42501/403
--     5) exists(... is_published = true)  -> 미게시 프로그램에 신청 (uuid 를 알아냈다고 가정).            위반 시 42501/403
--     + unique (student_id, program_id)   -> 중복 신청 (제약이 담당).                                     위반 시 23505/409
--   용도: 참여 신청 팝업의 "참석 신청하기" (docs/specs/student-programs.md)
--
--   [2번과 3·4번이 지금 무의미해 보이는 것이 정확히 위험 지점이다]
--   현재는 포인트 지급 로직이 없어 완료 상태를 위조해도 아무 일이 없다. 그러나 QR 퇴장 인증이 포인트를
--   지급하는 순간(CLAUDE.md 6장 3번), 이 절들이 없으면 학생은 status:'completed' 한 줄로 QR 이중 인증을
--   통째로 건너뛴다. QR 2회 인증은 부정 참여 방지 장치인데(2장 5번) 그 옆에 뒷문을 열어두는 셈이다.
--   >>> 이 절들을 "지금 안 쓰니까"라며 지우지 말 것. 이것이 ADR 0004 의 존재 이유다.
--
--   [5번 — with check 안의 서브쿼리에 대해]
--   RLS 정책 표현식은 일반 SQL 표현식이라 서브쿼리를 쓸 수 있다. 참조되는 programs 의 RLS 도 이 안에서
--   함께 적용되므로(정책 표현식은 질의자 권한으로 평가된다 — Supabase 가 이런 경우 security definer 함수를
--   권하는 이유가 바로 이것이다) programs_select_published 가 자동으로 걸린다. 그럼에도 p.is_published = true 를
--   명시적으로 다시 쓰는 이유: 관리자 프로그램 관리 스펙이 "admin 은 미게시도 select 가능" 정책을 programs 에
--   추가하면(20260716120000 마이그레이션 하단에 예고됨) 이 서브쿼리가 admin 에게 미게시 행을 보여주게 되어,
--   participations 의 경계가 다른 테이블 정책 변경에 딸려 조용히 흔들린다. 명시하면 이 정책이 자기 경계를 스스로 지킨다.
--   (무한 재귀 없음: programs 정책은 participations 를 참조하지 않는다.)
--
--   [date < 오늘(H-1) 과 status(full/over/ing) 를 여기서 막지 않는 이유 — 경계선: 권한은 DB, 신청 가능 여부는 프런트]
--     - is_published 는 "관리자가 아직 공개하지 않은 데이터" = 권한 경계라 DB 가 막는다.
--     - status 의 join 매핑은 프런트 STATUS 맵이 소유한다(ADR 0003 4번). DB 에 status in ('open','wait') 를
--       박으면 같은 규칙이 두 레이어로 쪼개져 드리프트한다.
--     - 지난 날짜 신청은 부정 적립이 되지 않는다(포인트는 QR 퇴장 인증에서만 나오고, 지난 프로그램엔 스캔할
--       관리자가 없다). 게다가 정책 안의 current_date 는 세션 TimeZone(Supabase 기본 UTC) 기준이라 KST 와
--       어긋나고, 이를 피하려 (now() at time zone 'Asia/Seoul')::date 를 박으면 날짜 소스가 프런트 todayISO()
--       와 두 곳으로 갈린다(ADR 0003 6번 타임존 주의).
--     - 인수 조건도 "DB 제약으로도 막힌다"를 중복 신청 1건에만 요구한다.
--
--   [to authenticated 를 명시하는 이유] student_id = auth.uid() 는 anon 에서 auth.uid() 가 NULL 이라 자연히
--   거짓이 되지만, 이 테이블은 앱 최초의 쓰기 경로라 대상 역할을 독자의 추론에 맡기지 않는다. 특히 insert 에서
--   to 를 생략하면 대상이 public 역할이 되어 anon 차단이 술어 하나에만 걸린다.
create policy "participations_insert_own"
  on public.participations
  for insert
  to authenticated
  with check (
    student_id = auth.uid()
    and status = 'applied'
    and entry_at is null
    and exit_at is null
    and entry_token is null
    and exit_token is null
    and exists (
      select 1
      from public.programs p
      where p.id = participations.program_id
        and p.is_published = true
    )
  );

-- [RLS 권한 경계] update/delete 정책 없음 = 기본 전체 거부 (모든 역할, 모든 행에 대해 차단)
--  - 확정 G-1: 신청 취소는 스코프가 아니다. mentor_students 에 정책을 0개 둔 원칙과 동일 — 필요할 때 연다.
--  - 정책이 0개면 RLS 가 행 자체를 보여주지 않으므로 update/delete 는 에러가 아니라 "0행 영향"으로 끝난다.
--  - 즉 학생은 신청 후 자기 행의 status 를 completed 로 바꾸거나 entry_at 을 채워 넣을 수 없다.
--  - 시연 리셋(delete from public.participations;)은 service_role 키로 수행되어 RLS 를 우회한다.
--
-- [학생이 지정 가능한 컬럼은 student_id, program_id 둘뿐이다]
--   나머지는 default 또는 위 with check 의 NULL 강제가 담당한다. 예외는 created_at(위 comment 의 "알려진 틈")과
--   id(본인 행의 PK 를 스스로 고르는 것뿐이라 무해). student_id 에 default auth.uid() 를 두지 않는 이유:
--   클라이언트가 값을 보내면 default 는 무시되므로 default 는 방어가 아니다 — 방어처럼 보이는 비방어 장치를
--   두면 나중에 읽는 사람이 "default 가 있으니 안전하다"고 오해한다. 방어는 오로지 with check 가 한다.
--
-- [포인트 지급 트리거를 만들지 않는다]
--   profiles 에 update 정책이 0개이고 point_transactions 테이블 자체가 없으므로, 신청만으로는 포인트가
--   1P 도 지급되지 않는다(CLAUDE.md 2장 3번 — 인수 조건의 시각 점검 항목). 지급 시점은 QR 퇴장 인증이며
--   (6장 3번) 그 경로는 QR 스펙에서 별도 ADR로 설계한다. 여기에 트리거를 붙이면 그 결정을 선점하게 된다.
--
-- [관리자 정책을 이번에 넣지 않는 이유 — ADR 0003 이 programs 에서 내린 판단과 동일 + 하나 더]
--   QR 스캔 시 관리자는 남의 participations 행을 update 해야 하지만, 그 정책의 행 경계(담당 학생만 vs 전체)와
--   컬럼 경계(entry_at/status 만)는 QR 토큰 검증 설계와 한 몸이라 지금 정하면 추측이 된다.
--   >>> 추가 근거(중요): RLS 는 컬럼 단위가 아니다. for update using (관리자 조건) 같은 정책을 순진하게 열면
--       관리자가 그 행의 모든 컬럼을 바꿀 수 있다(student_id 를 다른 학생으로 옮기는 것 포함).
--       그래서 QR 스캔은 정책보다 security definer RPC(토큰을 인자로 받아 서버가 컬럼을 확정)가 유력하다.
--       QR 스펙의 별도 ADR에서 결정한다.
--   담당 학생 아카이브용 admin select 정책은 mentor_students 정책과 한 세트라 아카이브 스펙 몫이다.
--
-- [QR 스펙에서 컬럼이 추가되면 이 정책을 반드시 함께 재검토할 것]
--   with check 는 행 단위 술어라 새 컬럼을 자동으로 막지 않는다. 다만 위 4개 토큰/시각 컬럼을 지금 봉인해 둔
--   덕분에 리스크는 크게 줄어 있다 — 예컨대 entry_token_expires_at 이 추가되고 정책 개정을 잊더라도, 학생은
--   여전히 entry_token 을 심을 수 없으므로 만료 시각만 위조된 "존재하지 않는 토큰"은 쓸모가 없다.
--   컬럼 단위 insert 권한(revoke insert ...; grant insert (student_id, program_id) ...)은 이번에 기각했다
--   (근거: ADR 0004 "대안으로 고려했던 것"). 컬럼이 더 늘고 update 정책까지 열리는 QR 스펙 시점이 그 방법의 자리다.

-- =========================================================
-- 참고: participations 데모 데이터는 시딩하지 않는다.
--  - 신청은 앱에서 학생이 직접 만든다 — 가짜 데이터를 하드코딩하지 않는다 (ADR 0004, 스펙 "추가 시드 불필요").
--    따라서 scripts/ 에는 이 마이그레이션에 대응하는 변경이 없다.
--  - [시연 리셋] delete from public.participations;
--    반드시 service_role 키로 실행한다 (Supabase 대시보드 SQL Editor 또는 service_role 클라이언트).
--    학생/관리자 세션으로는 delete 정책이 0개라 0행 영향으로 끝나고 아무것도 지워지지 않는다.
--  - "스키마는 마이그레이션, 데모 데이터는 scripts/" 라는 ADR 0002 의 관례와 일치한다.
-- =========================================================
