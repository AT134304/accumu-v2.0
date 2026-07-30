-- Accumu v2 — 마이그레이션: 프로그램 정원 게이트 (capacity gate)
-- 출처: docs/db/schema.sql (단일 스키마 소스, 4-1절) , docs/adr/0006-program-capacity-gate.md
-- 기능: docs/specs/admin-programs.md 확정 F (F-1 ~ F-9) / docs/specs/student-programs.md 확정 C-1 개정분
--
-- [이 마이그레이션이 하는 일은 딱 두 개다]
--   1) 함수  public.participations_capacity_guard()  (returns trigger, security definer)
--   2) 트리거 participations_capacity_guard  before insert on public.participations for each row
--   그 외에는 주석 3종(함수 / programs.capacity / program_status)뿐이다.
--
-- [이 마이그레이션이 만들지 않는 것 — 하나라도 늘어나면 설계가 어긋났다는 신호다 (ADR 0006 "스키마 변경 요약")]
--   - 새 테이블 / 새 컬럼 / 새 제약 / 새 인덱스: 0개
--     (특히 participations(program_id) 인덱스를 추가하지 말 것 — ADR 0004 주의 5 가 이름까지 지목해 금지했고,
--      예외는 "제약의 부산물인 인덱스"뿐이다(ADR 0005 결정 1-5). 이번에 필요한 건 조회 성능이라 예외가 아니다.
--      participations 는 데모 전체에서 수십 행이다.)
--   - 새 RLS 정책: 0개. 기존 정책 개정: 0개.
--     >>> participations_insert_own 은 with check 9절 그대로다. drop/create 하지 않는다(아래 3번 절).
--   - grant / revoke 변경: 0개. 컬럼 단위 grant insert (student_id, program_id) 는 그대로 유지한다.
--   - 호출 가능한 새 함수: 0개. "찼는가"를 알려주는 program_is_full() 류를 만들지 말 것
--     (그건 학생 화면의 사전 마감 표시 = 스펙 K-2 이고 아직 확정되지 않았다. 현재 확정은 K-1 = 사후 거부).
--   - 시드 capacity 채우기: 하지 않는다. 시드 20건이 전부 NULL 이어야 "기존 신청 동작 회귀 0건"(F-2)이 성립한다.
--
-- [이번에 열리는 조회 표면: 0개]
--   관리자에게 열린 participations 는 여전히 담당 5명의 completed 뿐이고(ADR 0005 결정 7-2(d)),
--   학생에게 열린 participations 는 여전히 본인 행뿐이다. 정원 게이트는 신청자 수를 아무에게도 보여주지 않는다(F-3).
--
-- [실행 순서] 20260709120000 -> 20260716120000 -> 20260716140000 -> 20260723120000 -> 이 마이그레이션
--   participations / programs 는 이미 존재한다. 이 파일은 그것들을 만들지 않고 트리거만 붙인다.
--
-- [재실행] create or replace function / create or replace trigger / comment on 만 쓰므로 재적용해도 안전하다
--   (기존 마이그레이션 3~4개와 달리 이 파일은 멱등이다).

-- =========================================================
-- 1. 정원 게이트 함수 (ADR 0006 결정 1 / 3 / 4 / 5)
--
-- [무엇을 막는가] capacity 가 지정된 프로그램에 정원을 넘는 "신규" 신청.
--   정원이 찼다 <=> capacity is not null and count(*) from participations where program_id = P >= capacity.
--   status 를 조건에 넣지 않는다(applied/entered/completed 전부 자리 1개다 — 스펙 F-2).
--   count 가 뒤로 가지 않는 근거: participations 에 update/delete 정책이 0개라 행이 사라지거나 되돌아갈 수 없다.
--
-- [왜 정책이 아니라 트리거인가 — ADR 0006 결정 1]
--   정원은 "교차 행 제약"이라 unique/check 로 표현할 수 없고, participations_insert_own 의 with check 에 넣으면
--     (1) 정책 표현식 안에서 participations 를 세어 정책 재귀,
--     (2) 통과시켜도 위반이 42501 로 나와 "권한 오류"와 구분 불가(F-6),
--     (3) 정책은 잠금을 걸 수단이 없어 동시 신청을 막지 못한다(F-7)
--   세 요구를 동시에 어긴다.
--   신청 자체를 security definer RPC 로 옮기는 안도 검토했으나, 그러려면 컬럼 단위 insert grant 를 회수해야 하고
--   그 순간 with check 9절이 "살아 있는 것처럼 보이지만 아무것도 막지 않는" 죽은 정책이 된다.
--   특히 not public.is_admin()(관리자 무한 적립 폐루프 차단)을 함수 본문에 다시 옮겨 적게 된다.
--   >>> 부가 기능(정원) 때문에 최대 보안 항목을 재작성하지 않는다. ADR 0006 결정 1-3.
--
-- [security definer 인 이유가 재귀 회피가 아니다 — 이 함수에서 가장 중요한 한 줄]
--   invoker(기본값)로 만들면 함수 안의 count 가 호출한 학생의 권한으로 평가된다. 학생에게 열린 정책은
--   participations_select_own(본인 행) 뿐이므로 count 는 항상 0 이 되고, 0 >= capacity 는 언제나 거짓이라
--   >>> 정원이 조용히 무력화된다. 에러도 로그도 경고도 없는 fail-open 이고, 시연에서 "정원 1인데 3명 다 신청됨"
--       으로만 드러난다. definer 는 편의가 아니라 정확성의 조건이다. invoker 로 바꾸지 말 것. (ADR 0006 결정 3-b)
--   is_admin() 도 definer 지만 목적이 다르다 — 저쪽은 정책 재귀 회피, 이쪽은 정확한 count.
--
-- [노출 표면 0] 트리거 전용 함수라 클라이언트에 값을 돌려줄 수 없다 = count 가 밖으로 나갈 경로가 구조적으로 없다.
--   revoke all from public 으로 직접 호출도 막는다(qr_generate_token() 전례). grant execute 를 아무에게도 주지 않는다.
-- =========================================================
create or replace function public.participations_capacity_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_capacity integer;
  v_taken    integer;
begin
  -- (1) 정원을 읽으면서 그 programs 행을 잠근다. 동시성 방어의 전부가 이 for update 다 (ADR 0006 결정 4).
  --     같은 프로그램에 동시에 도착한 두 신청은 여기서 직렬화되고, 두 번째는 첫 번째가 커밋된 뒤에
  --     (READ COMMITTED 는 문장마다 새 스냅샷을 뜬다) 갱신된 count 를 다시 읽어 거부된다.
  --     >>> 이 한 줄을 빼면 마지막 1자리에 두 건이 나란히 통과한다. 지우지 말 것.
  select p.capacity into v_capacity
    from public.programs p
   where p.id = new.program_id
   for update;

  -- (2) 없는 program_id 는 FK(23503)가 담당한다. 여기서 판정하면 거부 사유가 둘로 갈린다.
  if not found then
    return new;
  end if;

  -- (3) NULL = 무제한. 시드 20건이 전부 이 분기로 빠지므로 기존 신청 동작에 회귀가 없다(F-2).
  if v_capacity is null then
    return new;
  end if;

  -- (4) [사유 순서 보정 — 지우지 말 것. ADR 0006 결정 5-2]
  --     BEFORE INSERT 트리거는 unique 제약(23505)보다 먼저 실행된다. 이 절이 없으면 이미 신청한 학생의 재요청
  --     (다른 탭 / 오래된 화면)이 duplicate 대신 정원 거부로 나가고, 프런트가 "이미 신청됨" 상태 동기화 대신
  --     "마감" 을 표시한다 — 정작 그 학생은 자리를 갖고 있다.
  --     도메인적으로도 맞다: 이미 자리를 가진 사람은 정원에 막히는 대상이 아니다(F-4 를 insert 층에서도 성립시킨다).
  if exists (
    select 1
      from public.participations
     where program_id = new.program_id
       and student_id = new.student_id
  ) then
    return new;
  end if;

  -- (5) status 를 조건에 넣지 않는다 (F-2). definer 이므로 RLS 를 타지 않고 전원을 센다.
  select count(*) into v_taken
    from public.participations
   where program_id = new.program_id;

  if v_taken >= v_capacity then
    -- (6) [거부 신호 — 프런트 계약이다. 문자열을 바꾸거나 번역하지 말 것]
    --   errcode P0001 -> PostgREST HTTP 400. 42501(403)/23505(409)와 상태 코드부터 다르다.
    --   판별은 hint = 'capacity_full' 로 한다. P0001 은 raise exception 의 기본 코드라 다른 도메인 예외가
    --   생기면 언젠가 충돌한다 — 프런트는 code 가 아니라 hint 를 본다(ADR 0006 결정 5-1).
    --   [정보 노출 금지] message/detail 에 숫자를 넣지 말 것 — 신청자 수도, 정원 값도, 남은 자리 수도.
    --   detail 은 비운다. 밖으로 나가는 것은 "찼다" 라는 1비트뿐이다(결정 6).
    raise exception '정원이 모두 찼습니다.'
      using errcode = 'P0001',
            hint    = 'capacity_full';
  end if;

  -- (7) 통과.
  return new;
end;
$$;

comment on function public.participations_capacity_guard() is
  '[ADR 0006] 프로그램 정원 게이트. participations 의 before insert 트리거 전용 함수. '
  'capacity 가 NULL 이면 무제한이라 즉시 통과하고, 지정돼 있으면 그 프로그램의 참여 행 수를 세어 '
  'count >= capacity 이면 P0001 / hint=capacity_full 로 거부한다(status 무관 — F-2). '
  '[security definer 인 이유] 재귀 회피가 아니라 정확성이다 — invoker 면 count 가 participations_select_own 에 '
  '걸려 본인 행만 보이고 항상 0 이 되어 정원이 조용히 무력화된다(fail-open). '
  '[for update] 정원을 읽는 select 의 for update 가 동시 신청 직렬화의 전부다. 빼면 마지막 1자리에 두 건이 통과한다. '
  '[before insert 만] update 에 걸면 정원 초과 상태의 프로그램에서 QR 입·퇴장 스캔이 거부된다 — 절대 금지. '
  '[노출] 반환값이 없고 grant execute 도 없다. count 가 클라이언트에 도달할 경로가 존재하지 않는다.';

-- [권한 경계] 이 함수는 아무도 직접 호출할 수 없다.
--   트리거는 테이블 소유자 권한으로 함수를 호출하므로 grant execute 가 필요 없다(qr_generate_token() 전례).
--   >>> grant 를 추가하지 말 것. 호출 가능해지는 순간 "이 프로그램이 찼는가"를 묻는 표면이 생기고,
--       그건 스펙 K-2(사전 마감 표시) 영역이라 별도 확정이 필요하다.
revoke all on function public.participations_capacity_guard() from public;

-- =========================================================
-- 2. 트리거 — before insert ONLY
--
-- [경고 — or update 를 절대 붙이지 말 것. 붙이면 현장에서 사고가 난다. ADR 0006 결정 1-5]
--   verify_participation_qr() 은 participations 를 update 한다(status, entry_at/exit_at).
--   트리거가 update 에도 걸리면, 관리자가 정원을 줄여 count > capacity 가 된 프로그램에서
--   >>> 입장·퇴장 QR 스캔이 통째로 거부되고, 현장에 온 학생이 인증을 못 받고 돌려보내진다.
--   스펙이 "원칙 5 가드"로 명시 금지한 지점이다(정원 검사가 QR 검증 경로에 들어가면 안 된다).
--   정원은 "insert 시점의 게이트"일 뿐이며 기존 행에 소급 적용되지 않는다(F-4).
--   delete 도 마찬가지로 붙이지 않는다 — participations 에 delete 경로 자체가 없다(정책 0개).
--
-- 재적용 안전성: create or replace trigger 는 PG14+ 지원(Supabase 는 PG15+). 하위 호환이 필요하면
--   drop trigger if exists participations_capacity_guard on public.participations; 를 먼저 실행할 것.
-- =========================================================
create or replace trigger participations_capacity_guard
  before insert on public.participations
  for each row
  execute function public.participations_capacity_guard();

-- =========================================================
-- 3. 주석 갱신 (ADR 0006 결정 9-2 / 9-3)
--
-- [기존 마이그레이션 파일은 수정하지 않는다] 20260723120000_add_qr_auth_and_admin_boundaries.sql 은
--   이미 적용된 파일이라 고치지 않는다. 뒤집힌 comment 는 여기서 다시 실행해 DB 상의 값을 덮어쓴다.
-- =========================================================

-- 3-1. programs.capacity — ADR 0005 시점의 "정원 차단을 구현하지 않는다" 문장을 덮어쓴다.
--   덮어쓰기 전 문장(20260723120000 718~721줄, 이제 거짓):
--     "[ADR 0005] 관리자 프로그램 관리가 열려도 정원 차단을 구현하지 않는다 — 시드 20건 전부 capacity 가 NULL 이라
--      정원 개념이 데모에 존재하지 않는다(확정 C-1 유지)."
--   >>> 확정 F 로 뒤집혔다. 아래 (a)~(f) 6항목이 새 정본이다(ADR 0006 결정 9-2).
comment on column public.programs.capacity is
  '(a) NULL = 정원 미정/무제한. 검사 자체를 하지 않는다. 시드 20건은 전부 NULL 이므로 기존 프로그램의 신청 동작에 회귀가 없다. '
  '(b) [ADR 0006 — ADR 0005 의 "정원 차단을 구현하지 않는다" 를 뒤집는다] 정원 차단을 구현한다(확정 F). '
  '    막는 주체는 RLS 정책이 아니라 participations 의 before insert 트리거 participations_capacity_guard 다. '
  '(c) "찼다" 의 기준 = status 무관, 그 프로그램의 참여 행 수. count(*) where program_id = P >= capacity. '
  '    applied/entered/completed 를 모두 센다 — 어느 상태든 자리 1개이고, 전이 도중 count 가 흔들리지 않는다. '
  '(d) 기존 행에 소급 적용되지 않는다. 정원은 insert 시점의 게이트일 뿐이다 — 관리자가 정원을 줄여도 이미 신청한 '
  '    학생의 행/QR 발급/입장/퇴장/포인트 지급이 전부 그대로 동작한다(ADR 0005 결정 7-4 와 같은 계열의 판단). '
  '(e) status 파생에는 여전히 사용하지 않는다(확정 D / F-5). 정원이 차도 status 가 자동으로 full 이 되지 않는다. '
  '(f) 신청자 수를 관리자/학생 어느 화면에도 노출하지 않는다. 서버는 count 를 알지만 응답에 담지 않는다 — '
  '    거부 응답은 사유 1비트뿐이고 숫자가 없다. "N/20명"/"남은 자리 N석"/"마감 임박" 을 만들지 말 것.';

-- 3-2. program_status — 값은 그대로다. "정원이 차도 status 는 파생되지 않는다"만 덧붙인다(ADR 0006 결정 9-2 끝줄 / F-5).
--   ADR 0005 시점의 근거 문구("시드 20건 전부 capacity NULL")는 정원 차단이 생긴 뒤 오해를 부르므로 뺀다 —
--   status 가 파생값이 아닌 이유는 이제 "시드가 NULL 이라서"가 아니라 "그렇게 설계했기 때문"이다.
comment on type program_status is
  'open=참석 가능(신청 가능), ing=참석 중(진행 중), wait=대기(정원이 찼지만 대기 신청 가능), full=마감(모집 기한 종료), over=정원 초과. '
  '신청 가능 여부(join) 매핑과 표시 라벨은 프런트엔드 STATUS 맵이 소유한다 (Accumu_prototype.html 710~716줄). '
  '[ADR 0005] 관리자 프로그램 관리에서 이 값을 수동으로 지정한다 — 여전히 파생값이 아니다. '
  '[ADR 0006] 정원 차단이 도입된 뒤에도 이 값은 파생되지 않는다 — 정원이 차도 status 가 자동으로 full 이 되지 않는다. '
  '정원 게이트(DB 경계)와 status(표시용 라벨)는 서로 독립이며, 둘이 어긋난 상태(status=open 인데 정원이 참)를 수용한다.';

-- ---------------------------------------------------------
-- 3-3. participations_insert_own 의 [RLS 권한 경계] 주석 보강 (ADR 0006 결정 9-3)
--
-- >>> 정책 SQL 은 한 줄도 바꾸지 않는다. drop/create 하지 않는다.
--     (정책을 다시 만들면 with check 9절을 옮겨 적다가 한 절 — 특히 not public.is_admin() — 을 잃을 위험이 있다.
--      그 절은 20260723120000 이 "이 마이그레이션 최대의 보안 항목"이라고 부른 것이다.)
--     아래는 20260723120000 400~448줄의 거부 사유 목록에 이어 붙는 문서 블록이다.
--     단일 소스는 docs/db/schema.sql 4절이며 거기에는 이미 반영돼 있다.
--
--   [participations_insert_own 이 막는 것에 정원은 없다]
--     + 정원 초과 (capacity)             -> 이 정책이 막지 않는다. before insert 트리거
--                                          participations_capacity_guard 가 막는다 (ADR 0006).
--                                          위반 시 P0001 / hint='capacity_full' / HTTP 400.
--       [왜 정책이 아닌가] (1) 정책 표현식에서 participations 를 세면 정책 재귀,
--                          (2) 위반이 42501 로 나와 기존 거부 사유 7개(권한 오류)와 구분되지 않는다(F-6),
--                          (3) 정책은 잠금을 걸 수 없어 마지막 1자리에 동시 신청한 두 건이 둘 다 통과한다(F-7).
--       [실행 순서 주의] Postgres 의 insert 처리 순서는
--                          컬럼 grant(42501) -> BEFORE INSERT 트리거(P0001) -> RLS with check(42501)
--                          -> unique(23505) -> FK(23503) 이다.
--                        즉 트리거는 이 with check 보다 "먼저" 실행된다. 따라서 정원이 찬 미게시 프로그램에
--                        신청하면 42501 이 아니라 정원 거부가 먼저 나온다(수용 — 어느 쪽이든 거부이고 행은 안 생긴다).
--                        관리자가 정원 찬 자기 프로그램에 자기 이름으로 신청하는 경우도 같다.
--                        >>> 폐루프는 여전히 닫혀 있다: not public.is_admin() 은 그대로 살아 있고,
--                            트리거를 통과하더라도 그 절이 42501 로 막는다(2중 방어).
--                        같은 이유로 "이미 신청한 학생의 재신청"이 duplicate 대신 full 로 나갈 뻔했고,
--                        트리거 본문 (4)단계가 그것을 막는다(ADR 0006 결정 5-2).
-- ---------------------------------------------------------

-- =========================================================
-- 적용 후 확인 (anon 키 + 실제 계정으로. service_role 로 확인하면 RLS 를 우회해 아무것도 검증되지 않는다)
--   1) 정원 1짜리 프로그램 등록(관리자) -> 학생 A 신청 성공 -> 학생 B 신청 = P0001 / hint=capacity_full / 400
--   2) 학생 A 가 같은 프로그램에 재신청 -> 23505(duplicate) 여야 한다.
--      >>> capacity_full 이 나오면 함수 본문 (4)단계가 빠진 것이다. 이번 구현 최대의 함정.
--   3) 정원 1자리에 두 계정이 동시 신청 -> 정확히 1건만 성공, 참여 행 수가 capacity 를 넘지 않는다
--   4) capacity 가 NULL 인 시드 프로그램 신청 -> 이전과 완전히 동일하게 성공(회귀 0)
--   5) 학생 A/B 신청 후 관리자가 정원을 1로 축소 -> update 성공(막히지 않는다)
--      -> 두 학생 모두 QR 발급 -> 입장 -> 퇴장 -> 포인트 지급이 전부 정상
--   6) 정원이 차도 programs.status 는 그대로다
--   7) 관리자가 자기 이름으로 participations insert -> 여전히 42501/403 (폐루프 차단 생존 확인)
--   8) anon/authenticated 로 rpc/participations_capacity_guard 직접 호출 -> 거부(호출 표면이 없다)
--
-- [검증 데이터 정리] 시연용 DB 다. 테스트로 만든 participations 행과 programs 행은 service_role 로 지울 것.
--   포인트가 지급된 참여를 지울 때는 point_transactions 와 profiles.points_balance / points_total 을
--   함께 되돌려야 잔액과 원장이 어긋나지 않는다(20260723120000 하단 시연 리셋 절차와 동일).
-- =========================================================
