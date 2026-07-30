-- Accumu v2 — 마이그레이션: 포인트 원장 조회 + 만족도 평가(reviews) + 지역화폐 전환 + 관심 계열 저장
-- 출처: docs/db/schema.sql (단일 스키마 소스 — 1번 절 제약 / 5번 절 정책 / 8번 절 reviews / 9번 절 RPC 2개)
--       docs/adr/0007-mypage-ledger-reviews-and-profile-write-paths.md
-- 기능: docs/specs/student-archive-mypage.md (확정 K-1 / L-1 / M-1)
--
-- [이 마이그레이션에서 세 가지가 처음 열린다 — 먼저 알아야 할 사실]
--   1) 잔액을 "줄이는" 최초의 경로        : convert_points_to_currency() (지금까지 잔액은 늘기만 했다)
--   2) currency_balance 를 건드리는 최초의 코드 : 같은 함수. 절대 원칙 3(시뮬레이션)의 첫 구현이다.
--   3) 학생이 자기 profiles 를 바꾸는 최초의 경로 : set_career_interest()
--   >>> 그럼에도 profiles 의 update 정책은 여전히 0개다. 이 파일의 실질은 화면이 아니라
--       "profiles 에 두 번째·세 번째 writer 가 생기는데 정책은 계속 0개로 둘 수 있는가" 이고, 답은 그렇다이다.
--       못이 박힌 자리는 "함수가 하나뿐" 이 아니라 "정책이 0개" 다 (ADR 0007 결정 3-6).
--
-- 범위 (docs/db/schema.sql 을 그대로 옮긴 것이며, 여기에 없는 필드/정책/인덱스/함수를 추가하지 않는다):
--   1) 제약 1개  : profiles_balances_non_negative        + profiles 컬럼 주석 3종 갱신
--   2) 정책 1개  : point_transactions_select_own         + 테이블/enum 주석 갱신
--   3) 테이블 1개: public.reviews (제약 4개) + 정책 3개 + 컬럼 단위 insert/update grant
--   4) 함수 1개  : convert_points_to_currency(integer)   (security definer)
--   5) 함수 1개  : set_career_interest(public.career_track) (security definer)
--   6) 주석 1종  : participations 의 시연 리셋 절차 (currency_balance 초기화가 새로 필요하다)
--
-- [이 마이그레이션이 만들지 않는 것 — 하나라도 늘어나면 설계가 어긋났다는 신호다 (ADR 0007 구현 가이드 7번)]
--   - profiles 의 update/insert/delete 정책: 0개 유지. profiles 의 grant/revoke 조작: 0건.
--     >>> "정책 + grant update (career_interest)" 안은 기술적으로 동작하지만 기각했다. 보안 성질이 정책이 아니라
--         grant 한 줄에 얹혀 fail-open 이 되기 때문이다(Supabase 는 public 스키마 테이블에 authenticated 로
--         ALL 을 주는 기본 권한이 있다 — participations 에서 revoke insert 를 해야 했던 이유가 정확히 이것이다).
--         >>> 일반 규율: 컬럼 단위 grant 는 정책이 이미 표현한 경계 위의 2차 방어로만 쓴다.
--             그래서 reviews 에는 쓰고 profiles 에는 쓰지 않는다. (ADR 0007 결정 4-3 / 4-4)
--   - point_transactions 의 insert/update/delete 정책: 0개 유지 (학생 자가 발행 차단).
--     관리자용 select 정책: 0개 (admin-students.md 결정 D — 아카이브는 "무슨 활동을 했는가" 이지 "얼마 벌었는가" 가 아니다).
--   - reviews 의 delete 정책: 0개. delete grant 도 건드리지 않는다(정책 0개가 경계다 — participations 전례).
--   - 트리거: 0개. ADR 0006 이 트리거를 택한 이유는 "교차 행 제약"(정원)이었는데 이번 4건에는 교차 행 규칙이 없다.
--   - 조회용 인덱스: 0개. point_transactions(student_id) / (created_at) 를 추가하지 말 것.
--     이번에 늘어나는 인덱스는 reviews 의 PK 와 unique 2개뿐이고 둘 다 "제약의 부산물" 예외다(ADR 0005 결정 1-5).
--   - 새 시드: 0건. 빈 상태가 이 화면들의 기본 상태다.
--   - participations 의 새 정책/트리거/컬럼: 0개. participations_insert_own 을 drop/create 하지 않는다.
--   >>> 다음을 한 글자도 수정하지 않는다: participations_insert_own(with check 9절) / 컬럼 단위 insert grant /
--       issue_participation_qr() / verify_participation_qr() / participations_capacity_guard() /
--       point_transactions_source_rule CHECK.
--
-- [실행 순서] 20260709120000 -> 20260716120000 -> 20260716140000 -> 20260723120000 -> 20260730120000 -> 이 파일
--   profiles / participations / point_transactions 는 이미 존재한다. 이 파일은 그것들을 만들지 않는다.
--
-- [재실행] 멱등이다. 제약은 duplicate_object 가드, 정책은 drop if exists + create, 나머지는
--   create table if not exists / create or replace function / comment on / grant·revoke 뿐이다.
--   >>> 아래 drop policy if exists 는 "이 파일이 만드는 신규 정책 4개" 에만 쓴다. 기존 정책
--       (특히 participations_insert_own)에 이 패턴을 복사하지 말 것 — 다시 만들다가 with check 한 절을
--       잃는 것이 이 프로젝트에서 가장 비싼 사고다(20260730120000 3-3절).

-- =========================================================
-- 1. profiles — 잔액 음수 금지 CHECK + 주석 3종 갱신 (ADR 0007 결정 3-4 3차 방어 / 결정 3-6 writer 표)
--
-- [왜 지금인가] "잔액은 음수가 될 수 없다" 는 앱 전체의 불변식이 지금까지 어디에도 DB 로 적혀 있지 않았다.
--   잔액을 줄이는 경로가 처음 생기는 이 시점이 그 자리다. 기존 데이터는 전부 0 이상이라 적용 시 실패하지 않는다.
-- [인덱스 금지 원칙과 무관하다] 이것은 인덱스가 아니라 CHECK 제약이다.
-- [방어의 3층 중 3층] 1층 = 전환 함수의 조건부 UPDATE(points_balance >= p_amount),
--   2층 = point_transactions_amount_positive(amount > 0)가 트랜잭션 전체를 롤백,
--   3층 = 이 CHECK. 미래의 어떤 경로가 잔액을 음수로 만들려 해도 트랜잭션이 통째로 실패한다(fail-closed).
-- =========================================================
do $$ begin
  alter table public.profiles
    add constraint profiles_balances_non_negative
    check (points_balance >= 0 and points_total >= 0 and currency_balance >= 0);
exception
  when duplicate_object then null;   -- 재적용 안전성. 이미 있으면 그대로 둔다.
end $$;

-- 1-1. profiles.points_balance — ADR 0005 시점의 문장("profiles 를 쓰는 경로는 verify_participation_qr 하나뿐")을
--   덮어쓴다. 뒤집히는 것은 "유일한 함수" 이지 "정책 0개" 가 아니다.
comment on column public.profiles.points_balance is
  '[ADR 0005 + 0007 — profiles 를 쓰는 경로 전체 표. 여기 없는 경로가 생기면 그것이 사고다] '
  'points_balance : 증가 = verify_participation_qr() 뿐 / 감소 = convert_points_to_currency() 뿐. '
  'points_total   : 증가 = verify_participation_qr() 뿐 / 감소 = 없음(영구 누적. 전환해도 줄지 않는다). '
  'currency_balance: 증가 = convert_points_to_currency() 뿐 / 감소 = 없음(표시용 누적 숫자, 사용처 없음). '
  'career_interest : set_career_interest() 뿐.  id/role/code/name: 없음(시딩 = service_role). '
  '>>> 셋 다 security definer 함수이고 profiles 의 update 정책은 여전히 0개다 = 학생도 관리자도 직접 수정할 수 없다. '
  '    못이 박힌 자리는 "함수가 하나뿐" 이 아니라 "정책이 0개" 다. 함수를 추가할 때는 UPDATE SET 목록에 '
  '    그 기능의 컬럼만 적고 이 표를 함께 갱신할 것. update 정책을 여는 선택지는 검토 대상이 아니다 (ADR 0007 결정 3-6). '
  '지급 사유는 point_transactions 에 1행씩 남는다 — 잔액과 원장이 어긋나면 위 경로 밖에서 누가 손댄 것이다.';

-- 1-2. profiles.currency_balance — "어떤 경로로도 건드리지 않는다"(ADR 0005) 가 이번에 뒤집힌다.
comment on column public.profiles.currency_balance is
  '시뮬레이션 지역화폐 누적액 (1P = 1원 개념). [절대 원칙 3] 실제 결제/계좌/외부 API 연동이 0줄이다. '
  '[ADR 0007] 이 값을 늘리는 유일한 경로는 convert_points_to_currency() 이고, 줄이는 경로/사용처/잔액 차감 API 를 만들지 않는다. '
  '화면에서는 "전환한 지역화폐 N원" 표시 전용이다. [시연 리셋 시 이 컬럼도 0 으로 되돌려야 한다]';

-- 1-3. profiles.career_interest — 쓰기 경로가 처음 생겼다(그래도 update 정책은 0개다).
comment on column public.profiles.career_interest is
  '학생의 관심 진로 계열. programs.career_track 과 같은 career_track 타입을 공유해 홈 추천 매칭의 값 공간이 일치함을 보장한다 (ADR 0003). '
  'NULL 허용은 의도된 도메인 상태: (1) 학생이 아직 계열을 고르지 않음 -> 홈 추천은 최신순 fallback (스펙 확정 E), '
  '(2) role=admin 은 계열 개념 자체가 없음. '
  '[ADR 0007] 이 컬럼을 바꾸는 유일한 경로는 public.set_career_interest(career_track) 이다. '
  '인자 타입이 enum 이라 5종/NULL 외의 값은 함수 본문에 도달조차 못 한다. 관리자는 호출할 수 없다(학생 전용 개념). '
  '확정 K-1: 단일 유지. 배열(career_track[])로 넓히지 않는다 — 넓히면 ADR 0003 의 타입 공유 보장이 = ANY 로 느슨해진다.';

-- =========================================================
-- 2. point_transactions — select 정책 1개 (ADR 0005 가 "마이페이지 스펙에서 열 자리" 로 예약해둔 정책)
--
-- [이 테이블의 정책은 앞으로도 이 1개뿐이다]
--   insert/update/delete 정책은 0개를 유지한다 — 학생이 원장에 직접 쓸 수 있으면 포인트를 스스로 찍어낼 수 있고,
--   그건 이 테이블이 막으려던 바로 그 공격이다(ADR 0005 결정 3-1).
--   쓰기는 계속 definer 함수 2개 안에서만 일어난다: 적립 = verify_participation_qr(), 전환 = convert_points_to_currency().
-- =========================================================

-- [RLS 권한 경계] point_transactions_select_own
--   대상 역할: authenticated
--   허용 행: student_id = auth.uid() 인 행만 select
--   용도: 마이페이지 포인트 내역(적립/전환 시간순 50건) + 아카이브 활동 행의 포인트 표시(확정 L-1)
--   불가능: 다른 학생의 원장 조회(0행), 관리자의 조회(아래), 어떤 역할의 insert/update/delete 도(정책 0개)
--
--   [컬럼 노출 범위 — 전부 열리고 그래도 안전하다] RLS 는 행 단위라 보이는 행의 모든 컬럼이 열린다.
--     student_id 는 언제나 본인이고, related_participation_id 는 반드시 본인의 참여를 가리킨다
--     (유일한 생성자인 verify_participation_qr 이 (v_p.student_id, ..., v_p.id) 를 같은 행에서 함께 꺼내 쓴다).
--     전환 행은 NULL 이다(CHECK). >>> 남에 대한 정보가 한 컬럼도 없으므로 컬럼 grant 로 좁힐 이유가 없다.
--
--   [관리자에게 열지 않는다 — 뒤집지 말 것] docs/specs/admin-students.md 결정 D 가 "관리자 아카이브에 포인트를
--     표시하지 않는다" 로 확정했고 그 근거가 "원장 테이블을 관리자에게 처음 여는 결정을 하지 않는다" 였다.
--     정책이 본인 축 하나뿐이므로 관리자가 조회하면 본인 행만 나오는데, 관리자에게는 적립 행이 존재할 수 없다
--     (participations_insert_own 의 not is_admin() 때문에 참여를 만들 수 없고, 적립은 참여에서만 나온다).
--     전환도 convert_points_to_currency() 가 관리자를 42501 로 막는다. >>> 결과적으로 항상 0행이다.
--     관리자용 정책을 추가하지 말 것.
drop policy if exists "point_transactions_select_own" on public.point_transactions;
create policy "point_transactions_select_own"
  on public.point_transactions
  for select
  to authenticated
  using (student_id = auth.uid());

-- [인덱스를 추가하지 않는다] 마이페이지 조회가 student_id 필터 + created_at 정렬 + limit 50 이라
--   인덱스를 부르고 싶어지지만, ADR 0003 주의 4 / 0004 주의 5 / 0006 결정 8 의 원칙 그대로다.
--   예외는 "제약의 부산물인 인덱스" 뿐인데(ADR 0005 결정 1-5) 이건 조회 성능이다. 데모 전체에서 수십 행이다.

-- 2-1. point_transactions 테이블 주석 갱신 — "정책 0개" 문장이 뒤집힌다.
--   덮어쓰기 전 문장(20260723120000, 이제 거짓): "RLS 활성화 + 정책 0개 = 어떤 클라이언트도 직접 읽거나 쓸 수 없다".
comment on table public.point_transactions is
  '포인트 적립/전환 원장 (CLAUDE.md 5장). 생성 주체는 둘뿐이다: '
  '적립 = public.verify_participation_qr() 의 퇴장 인증 성공 시 1행, 전환 = public.convert_points_to_currency() 1행. '
  '[RLS — ADR 0007] select 정책 1개(본인 축)만 열려 있고 insert/update/delete 정책은 여전히 0개다. '
  '학생이 원장에 직접 쓸 수 있으면 포인트를 스스로 찍어낼 수 있다 = 이 테이블이 막으려던 바로 그 공격이다. '
  '관리자용 정책은 만들지 않았다 — 담당 학생 아카이브는 "무슨 활동을 했는가" 이지 "얼마 벌었는가" 가 아니다(원칙 4). '
  '관리자 계정의 조회 결과는 구조적으로 항상 0행이다(관리자에게는 적립도 전환도 생길 수 없다).';

-- 2-2. point_transaction_type 주석 갱신 — "이번 스코프에서 생성되는 값은 적립 하나뿐" 문장이 뒤집힌다.
comment on type point_transaction_type is
  '적립=활동 참여 완료(QR 퇴장 인증)로 포인트가 늘어난 거래, 전환=포인트를 지역화폐로 바꾼 거래(시뮬레이션). '
  '[ADR 0007] 생성 주체는 각각 하나뿐이다: 적립 = public.verify_participation_qr(), 전환 = public.convert_points_to_currency(). '
  '두 값 모두 amount 는 양수이며 부호를 쓰지 않는다 — 방향은 type 이 정한다. '
  '전환에도 실제 결제/계좌/외부 API 연동은 0줄이다 (CLAUDE.md 2장 3번).';

-- =========================================================
-- 3. reviews (ADR 0007 결정 2 — CLAUDE.md 5장 / 6장 3번 "퇴장 인증 완료 시 만족도 평가")
--
-- [권한 구조 한눈에]
--   select : 본인 참여의 리뷰만. 관리자도 다른 학생도 0행.
--   insert : 완료된(status='completed') 본인 참여에만. 컬럼 grant (participation_id, rating, comment).
--   update : 같은 경계 + 컬럼 grant (rating, comment) — participation_id 를 옮길 수 없다.
--   delete : 정책 0개. 삭제 경로를 만들지 않는다(수정으로 갈음 — 스펙 결정 D-4).
--
-- [왜 정책이고 RPC 가 아닌가] ADR 0005 결정 2-2 의 5가지 사유 중 해당하는 것이 0개다:
--   컬럼 경계는 컬럼 grant 가 2차로 봉인하고, 정책 표현식에 넘길 인자가 없고(participation_id 는 삽입될 행 안에 있다),
--   남의 행을 수정하지 않고, 쓰기가 1행이라 원자성 요구가 없고, 거부 사유가 하나다.
--   = "RLS 로 표현할 수 없는 쓰기만 RPC"(ADR 0006 결정 1-3(a)) 기준에서 이건 RLS 쪽이다.
--
-- [부작용 0] 리뷰 저장이 participations / point_transactions / profiles 를 건드리지 않는다. 트리거를 만들지 않았고
--   participations 의 update 정책은 여전히 0개다. >>> 평가를 남겨도 포인트가 늘지 않는다(원칙 1 가드).
--
-- [participations 에 컬럼을 추가하지 않은 이득] ADR 0005 는 "participations 에 컬럼이 추가되면 또
--   participations_insert_own 을 재검토해야 한다" 고 경고했다. 별도 테이블이라 그 재검토가 아예 발생하지 않는다.
-- =========================================================
create table if not exists public.reviews (
  id                uuid primary key default gen_random_uuid(),
  participation_id  uuid not null references public.participations(id) on delete cascade,
  rating            integer not null,
  comment           text,
  created_at        timestamptz not null default now(),

  -- [1참여 1리뷰] 같은 활동에 리뷰가 2행 생길 수 없다. 아카이브가 "어느 것을 표시할지" 고민할 자리를 없앤다.
  --   위반 시 23505 -> 409. 프런트는 이것을 에러가 아니라 "수정 경로로 전환" 신호로 다룬다.
  --   [인덱스 예외] 이 unique 가 만드는 인덱스가 이번 변경에서 유일하게 추가되는 인덱스다
  --   ("제약의 부산물" 예외 — ADR 0005 결정 1-5). 조회용 인덱스는 하나도 만들지 않는다.
  constraint reviews_participation_unique unique (participation_id),

  -- 별점 1~5 정수(스펙 D-3). 범위 밖은 DB 가 거부한다(23514). 프런트 검증은 우회 가능하다.
  constraint reviews_rating_range check (rating between 1 and 5),

  -- 한줄평은 선택이고 60자 상한(프로토타입 maxlength=60). 프런트 maxlength 는 우회 가능하므로 DB 에도 건다.
  --   빈 문자열은 막지 않는다 — 프런트가 빈 값을 null 로 보내는 규율을 진다(''을 23514 로 튕기면
  --   정상 UI 에서 발생하는 오류가 생긴다).
  constraint reviews_comment_length check (comment is null or char_length(comment) <= 60)
);

comment on table public.reviews is
  '활동 만족도 평가(별점 + 한줄평). CLAUDE.md 5장 필드 + created_at. 6장 3번("퇴장 인증 완료 시 자동 노출")의 구현체다. '
  '[원칙 1 가드가 UI 규율이 아니라 RLS 구조다] 본인만 읽으므로 평균 별점/리뷰 수/인기 정렬/평가 완료율을 '
  '만들려 해도 데이터를 얻을 수 없다. CLAUDE.md 2장 1번이 "별점 리뷰" 를 허용하되 집계되어 순위가 되는 순간 '
  '위반이 되므로, 그 경로를 정책으로 차단한다. '
  '[updated_at 을 두지 않는다] 수정은 허용하지만 화면 어디에도 "수정됨" 표시가 없다. 쓰이지 않는 컬럼을 만들지 않는다. '
  '[student_id 를 비정규화하지 않는다] 소유자는 participation_id 로 유일하게 결정된다. 컬럼을 두면 '
  'participations.student_id 와 어긋날 자리가 생기고 정합용 트리거가 또 필요해진다.';
comment on column public.reviews.participation_id is
  '리뷰 대상 참여. unique 라 한 참여당 최대 1행이다. on delete cascade 로 둔 이유: 시연 리셋'
  '(delete from participations)이 리뷰를 남기면 "참여는 없는데 평가만 있는" 상태가 된다'
  '(point_transactions.related_participation_id 전례 그대로). '
  '[이 컬럼은 update 컬럼 grant 에 없다] = 리뷰를 다른 참여로 옮기는 문장 자체를 쓸 수 없다.';
comment on column public.reviews.rating is
  '별점 1~5 (필수). 표시 라벨 5종("별로였어요"~"최고였어요!")과 별 색(amber)은 프런트가 소유한다. '
  '[원칙 4 위반이 아닌 이유] 별점은 포인트 표시가 아니고 CLAUDE.md 2장 1번이 명시적으로 허용한 요소다.';
comment on column public.reviews.comment is
  '한줄평(선택). 60자 상한을 DB CHECK 로 건다 — 프런트 maxlength 는 우회 가능하다. '
  '빈 문자열은 CHECK 로 막지 않는다. >>> 프런트가 빈 값을 null 로 보내는 규율을 진다(comment.trim() || null).';

alter table public.reviews enable row level security;

-- [RLS 권한 경계] reviews_select_own
--   대상 역할: authenticated
--   허용 행: 본인 참여(participations.student_id = auth.uid())의 리뷰만
--   불가능: 다른 학생의 리뷰 조회, 관리자의 조회(담당 학생 것 포함), 프로그램 단위 집계
--
--   [★★ p.student_id = auth.uid() 를 "RLS 가 어차피 막아준다" 며 지우지 말 것 — 이 마이그레이션에서 가장 위험한 지점]
--     정책 표현식 안의 서브쿼리는 질의자 권한으로 평가되므로 participations 의 RLS 를 탄다. 그런데 관리자에게는
--     participations_select_mentored_as_admin(담당 5명의 completed)이 열려 있다. 따라서
--       exists (select 1 from public.participations p where p.id = reviews.participation_id)
--     로 "단순화" 하는 순간 >>> 관리자가 담당 학생 5명의 리뷰를 전부 읽는다.
--     스펙 결정 E("본인만 읽는다. 관리자도 못 읽는다")가 통째로 무너진다.
--     ADR 0005 결정 6-3 이 p.is_published = true 에서 이미 한 번 확인한 함정과 같은 계열이며(정책 서브쿼리가
--     다른 정책 덕에 더 넓게 보이게 되는 현상), 처방도 같다 — 경계를 명시적으로 다시 건다.
--     부수 효과로 이 절은 학생 <-> 학생도 막고, 평균 별점/리뷰 수/인기 정렬을 구조적으로 불가능하게 만든다.
--
--   [select 에는 status='completed' 를 넣지 않는다] 상태 전이가 단방향(applied->entered->completed)이라
--     리뷰가 존재한다는 것은 이미 완료됐다는 뜻이다(insert 정책이 completed 를 요구했다). 조건을 늘리면
--     미래에 "리뷰가 안 보이는" 경로만 늘어난다.
--
--   [정책 재귀 없음] 참조 방향이 reviews -> participations -> {programs, mentor_students} 로 단방향이다.
--     >>> participations 쪽 정책에서 reviews 를 참조하지 말 것. 그 순간 순환이 된다(ADR 0005 결정 7-2(a) 규율).
drop policy if exists "reviews_select_own" on public.reviews;
create policy "reviews_select_own"
  on public.reviews
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.participations p
      where p.id = reviews.participation_id
        and p.student_id = auth.uid()          -- ★ 이 절이 관리자 차단의 전부다. 지우지 말 것.
    )
  );

-- [RLS 권한 경계] reviews_insert_own
--   대상 역할: authenticated
--   허용 행: participation_id 가 (a) 본인 참여이고 (b) status = 'completed' 인 경우만
--   불가능: 남의 참여에 작성(42501), 미완료(applied/entered) 참여에 작성(42501),
--           같은 참여에 2행(23505 — unique 가 담당), id/created_at 지정(컬럼 grant 가 담당)
--   [게시중단된 프로그램의 완료 건에도 평가할 수 있다] 경계가 participations 이지 programs 가 아니고,
--     participations_select_own 에 is_published 조건이 없다. 스펙 "방어적 렌더" 요구와 일치한다.
drop policy if exists "reviews_insert_own" on public.reviews;
create policy "reviews_insert_own"
  on public.reviews
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.participations p
      where p.id = reviews.participation_id
        and p.student_id = auth.uid()          -- ★ 위 경고 참고. 빼면 경계가 무너진다.
        and p.status = 'completed'
    )
  );

-- [RLS 권한 경계] reviews_update_own
--   대상 역할: authenticated
--   허용 행: using(OLD) / with check(NEW) 양쪽이 같은 조건 — 본인의 completed 참여
--   불가능: 남의 리뷰 수정, 남의 참여로 participation_id 이동(with check + 컬럼 grant 2중)
--   [양쪽에 다 거는 이유] using 만 걸면 "남의 참여로 옮기는" NEW 를 검사하지 못한다
--     (programs_update_own_as_admin 이 소유권 이전을 막은 것과 같은 규율).
--     본인의 "다른" 완료 참여로 옮기는 것은 with check 로 막을 수 없는데(RLS 는 OLD/NEW 를 연결할 수단이 없다 —
--     ADR 0005 결정 2-2-1), 그건 아래 컬럼 grant 가 문장 층에서 막는다.
--   [프런트 주의] .update() 는 0행이어도 error === null 이다. 반드시 .select() 로 영향 행을 확인할 것.
drop policy if exists "reviews_update_own" on public.reviews;
create policy "reviews_update_own"
  on public.reviews
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.participations p
      where p.id = reviews.participation_id
        and p.student_id = auth.uid()          -- ★ 위 경고 참고.
        and p.status = 'completed'
    )
  )
  with check (
    exists (
      select 1
      from public.participations p
      where p.id = reviews.participation_id
        and p.student_id = auth.uid()          -- ★ 위 경고 참고.
        and p.status = 'completed'
    )
  );

-- [RLS 권한 경계] reviews delete 정책 없음 = 전체 거부. 삭제 경로를 만들지 않는다(수정으로 갈음).
--   delete grant 도 건드리지 않는다 — 정책 0개가 경계다(participations 전례).
--   >>> 규율: grant/revoke 조작은 "무언가를 돌려줄 때" 만 한다 (ADR 0007 결정 4-4).

-- [권한 경계] 컬럼 단위 insert/update grant — ADR 0005 결정 6-2 의 규율을 새 테이블에도 적용한다.
--   효과 1: update 목록에 participation_id 가 없으므로 "리뷰를 다른 참여로 옮기는" 문장 자체를 쓸 수 없다.
--           RLS 만으로는 여기까지 못 간다(with check 는 NEW 만 보므로 "본인의 다른 완료 참여로 이동" 을 못 막는다).
--           before update 트리거로도 가능하지만 컬럼 grant 가 함수 0개로 같은 결과를 낸다.
--   효과 2: insert 목록에 id / created_at 이 없으므로 위조가 처음부터 닫혀 있다. 앞으로 컬럼이 늘어도 fail-closed.
--   주의 1: revoke 가 필요한 이유는 Supabase 가 public 스키마 신규 테이블에 authenticated/anon 으로 ALL 을 주기
--           때문이다(participations 에서 이미 겪었다). revoke 없이 grant 만 하면 아무것도 좁혀지지 않는다.
--   주의 2: 위반도 42501/403 이라 정책 위반과 구분되지 않는다. 프런트는 위 목록 외 어떤 컬럼도 보내지 않는다.
--   주의 3: select 는 회수하지 않는다 — 행 경계는 정책이 소유하고 컬럼은 전부 본인 데이터다.
--           RETURNING(supabase-js 의 .insert().select())이 select 권한을 쓰므로 계속 동작한다.
--   [여기서는 컬럼 grant 를 쓰고 profiles 에서는 쓰지 않는 이유] 여기서는 정책 3개가 이미 행 경계를 완전히
--   표현하고 grant 는 그 위에 얹는 2차 방어다. profiles 에서는 grant 가 유일한 1차 경계가 되어 fail-open 이다
--   (위 1번 절 헤더 참고). >>> 규율: 컬럼 grant 는 2차 방어로만 쓴다.
revoke insert, update on public.reviews from authenticated;
revoke insert, update on public.reviews from anon;
grant  insert (participation_id, rating, comment) on public.reviews to authenticated;
grant  update (rating, comment)                   on public.reviews to authenticated;

-- =========================================================
-- 4. convert_points_to_currency() — 포인트 -> 지역화폐 전환 (절대 원칙 3: 시뮬레이션)
--
-- [RPC 권한 경계] convert_points_to_currency(p_amount integer)
--   호출 가능: authenticated. 본문에서 (a) 로그인 여부 (b) 관리자가 아님 을 검사한다.
--   허용 대상: auth.uid() 본인 행뿐. 함수가 student_id 를 인자로 받지 않는다 = 남의 잔액을 전환할 경로가 없다.
--   쓰는 컬럼: profiles.points_balance / currency_balance + point_transactions 1행.
--   >>> points_total / role / code / name / career_interest 를 절대 쓰지 않는다. 누적은 영구 기록이다.
--   불가능: 잔액 초과 전환(도메인 실패), 음수/단위 위반 금액(22023), 관리자 호출(42501),
--           남의 잔액 전환(경로 없음), anon 호출(revoke execute from public + auth.uid() null)
--
-- [반환]
--   성공: { ok:true, amount, points_balance, points_total, currency_balance, at }
--   실패: { ok:false, reason:'insufficient_balance', points_balance, points_total, currency_balance }
--   >>> 갱신된 잔액을 함께 싣는 이유: 프런트가 profiles 를 재조회하는 왕복을 없애고(AuthContext 갱신),
--       실패 시에도 화면의 잔액을 최신값으로 맞출 수 있다(두 탭 시나리오).
--   >>> 잔액 부족은 42501 이 아니다. 권한 오류와 화면 문구가 반드시 달라야 한다(ADR 0005 결정 4 규율).
--
-- [★ 금액 검증은 UX 가 아니라 보안 경계다 — 절대 생략하지 말 것 (ADR 0007 결정 3-4)]
--   p_amount 가 음수면  points_balance - (-N) = 증가 이고, where 절의 points_balance >= p_amount 도 언제나 참이다.
--   = 학생이 RPC 한 번으로 포인트를 무한히 찍어낸다. 절대 원칙 3 과 "포인트를 늘리는 경로는
--     verify_participation_qr() 하나뿐" 이라는 불변식이 통째로 무너진다.
--   >>> 방어는 3중이다:
--       1차 = 아래 (2)단계의 p_amount > 0
--       2차 = (5)단계 원장 insert 가 point_transactions_amount_positive(amount > 0)에 걸려 23514 로 튕기고,
--             같은 트랜잭션인 (3)단계의 잔액 증가까지 함께 롤백된다.
--             >>> 그래서 원장 insert 를 잔액 update "뒤" 에 둔다. 순서를 바꾸면 이 2차 방어가 사라진다.
--       3차 = profiles_balances_non_negative CHECK (위 1번 절).
--   (% 10 과 >= 100 은 도메인 규칙(스펙 확정 F)이고, > 0 만이 보안 경계다 — 성격이 다르니 함께 지우지 말 것.)
--
-- [동시성 / 음수 방지 = 조건부 UPDATE 한 문장]
--   where points_balance >= p_amount 로 잠그고 검사한다. 같은 행에 동시 도착한 두 UPDATE 중 두 번째는
--   행 잠금에서 대기했다가 READ COMMITTED 규칙에 따라 "갱신된 행 버전으로 WHERE 를 다시 평가"(EvalPlanQual)하므로
--   줄어든 잔액을 보고 0행이 된다. 잔액 1,150P 에 1,000P 전환 두 건이 겹치면 정확히 1건만 성공한다.
--   >>> 별도 select ... for update 가 필요 없다. 조건부 UPDATE 자체가 잠금이자 검사다.
--   이는 ADR 0005 결정 3-3 의 CAS(where ... and status = '이전 상태' + 영향 행 검사)와 완전히 같은 기법이며,
--   여기서는 상태 대신 잔액이 조건일 뿐이다.
--
-- [멱등이 아니다 — QR 과 다른 점] 전환을 두 번 하면 두 번 차감되는 것이 정상 도메인이다. 전환용 unique 제약을
--   만들지 않는다(related_participation_id 가 NULL 이라 만들 수도 없다). 더블클릭 방어는 프런트 버튼 잠금이며,
--   서버가 매번 잔액을 검사하므로 정합은 어떤 경우에도 깨지지 않는다. 취소/환급 경로도 만들지 않는다(스펙 결정 G).
--
-- [절대 원칙 3] 결제/계좌/외부 API 호출이 0줄이다. currency_balance 는 표시용 누적 숫자이고 사용처가 없다.
-- =========================================================
create or replace function public.convert_points_to_currency(p_amount integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student  uuid := auth.uid();
  v_balance  integer;
  v_total    integer;
  v_currency integer;
  v_now      timestamptz := now();
begin
  -- (1) 호출자 신원. 학생/관리자가 같은 DB 역할(authenticated)이므로 "학생만" 은 여기서만 표현된다.
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if public.is_admin() then
    -- 관리자는 참여할 수 없어 잔액이 언제나 0 이다(participations_insert_own 의 not is_admin()).
    -- 포인트/지역화폐는 학생의 도메인이라는 불변식을 여기서도 명시한다 (CLAUDE.md 4장).
    raise exception '학생만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  -- (2) 금액 검증. ★ 위 주석 참고 — 음수 인자는 잔액을 "늘리는" 경로다. 절대 생략하지 말 것.
  --     10P 단위 / 최소 100P 는 도메인 규칙(스펙 확정 F), p_amount > 0 은 보안 경계다.
  if p_amount is null or p_amount <= 0 or p_amount % 10 <> 0 or p_amount < 100 then
    raise exception '전환 금액이 올바르지 않습니다.' using errcode = '22023';
  end if;

  -- (3) 차감 + 지역화폐 증가. SET 목록에 points_total 이 없다(누적은 영구 기록 — ADR 0005 결정 3-4).
  --     role / code / name / career_interest / id 도 없다. 이 SET 목록이 곧 컬럼 경계다.
  update public.profiles
     set points_balance   = points_balance   - p_amount,
         currency_balance = currency_balance + p_amount
   where id = v_student
     and points_balance >= p_amount        -- ★ CAS: 음수 방지 + 동시 요청 직렬화의 전부. 빼지 말 것.
  returning points_balance, points_total, currency_balance
       into v_balance, v_total, v_currency;

  -- (4) 0행 = 잔액 부족. 도메인 실패이므로 예외가 아니라 반환값이다(42501 과 반드시 구분된다).
  if not found then
    select p.points_balance, p.points_total, p.currency_balance
      into v_balance, v_total, v_currency
      from public.profiles p
     where p.id = v_student;
    if not found then
      raise exception '프로필을 찾을 수 없습니다.' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'ok', false,
      'reason', 'insufficient_balance',
      'points_balance', v_balance,
      'points_total', v_total,
      'currency_balance', v_currency
    );
  end if;

  -- (5) 원장 1행. ★ 이 insert 가 (3)보다 뒤에 있어야 2차 방어가 성립한다(위 주석). 순서를 바꾸지 말 것.
  --     related_participation_id 는 반드시 NULL 이다 — point_transactions_source_rule CHECK 가
  --     (type='전환' and related is null) 을 요구한다. 그 CHECK 를 수정하지 말 것(ADR 0005 결정 3-1).
  insert into public.point_transactions (student_id, type, amount, related_participation_id)
  values (v_student, '전환', p_amount, null);

  return jsonb_build_object(
    'ok', true,
    'amount', p_amount,
    'points_balance', v_balance,
    'points_total', v_total,
    'currency_balance', v_currency,
    'at', v_now
  );
end;
$$;

comment on function public.convert_points_to_currency(integer) is
  '[ADR 0007] 포인트 -> 지역화폐 전환(시뮬레이션, 절대 원칙 3). points_balance 차감 + currency_balance 증가 + '
  'point_transactions(type=전환) 1행이 한 트랜잭션이다. points_total 은 건드리지 않는다(누적은 영구 기록). '
  '[음수 인자가 포인트 자가 발행 경로다] p_amount > 0 검증은 UX 가 아니라 보안 경계다. 2차 방어로 원장의 '
  'amount > 0 CHECK 가 트랜잭션 전체를 롤백하고(그래서 원장 insert 가 잔액 update 뒤에 있다), '
  '3차로 profiles_balances_non_negative 가 있다. '
  '[동시성] where points_balance >= p_amount 조건부 UPDATE 한 문장이 잠금이자 검사다(READ COMMITTED 재평가). '
  '[거부 신호] 잔액 부족은 예외가 아니라 ok=false / reason=insufficient_balance 다 — 42501(권한)과 반드시 구분된다. '
  '[멱등이 아니다] 두 번 호출하면 두 번 차감되는 것이 정상 도메인이다. 실제 결제/계좌/외부 API 호출은 0줄이다.';

revoke all on function public.convert_points_to_currency(integer) from public;
grant execute on function public.convert_points_to_currency(integer) to authenticated;

-- =========================================================
-- 5. set_career_interest() — 학생 본인의 관심 진로 계열 저장/해제
--
-- [RPC 권한 경계] set_career_interest(p_track public.career_track)
--   호출 가능: authenticated. 본문에서 (a) 로그인 여부 (b) 관리자가 아님 을 검사한다.
--   허용 대상: auth.uid() 본인 행뿐. 함수가 학생 id 를 인자로 받지 않는다.
--   쓰는 컬럼: profiles.career_interest 하나뿐.
--   >>> points_balance / points_total / currency_balance / role / code / name / id 는 이 함수의 시그니처에도
--       UPDATE 문장에도 등장하지 않는다. "그 컬럼을 고를 수 있는 지점" 이 설계상 존재하지 않는다.
--   불가능: 남의 계열 변경(경로 없음), 관리자의 학생 계열 변경(관리자 기능 3종 밖 — 42501),
--           career_track 5종 외의 값(인자 캐스팅 단계에서 22P02/400. 함수 본문에 도달조차 못 한다)
--
-- [★ 인자 타입을 text 로 바꾸지 말 것] ADR 0003 결정 3 이 programs.career_track 과 profiles.career_interest 가
--   같은 타입을 공유하게 만들어 값 공간 일치를 타입 시스템에 맡겼다. 인자를 text 로 받으면 쓰기 경로에서만
--   그 보장이 사라지고, 5종 목록을 함수 본문에 다시 적게 된다(드리프트). enum 인자면 "5종 또는 NULL만 허용" 을
--   함수가 검증할 필요조차 없이 DB 가 처리한다.
--   (issue_participation_qr 의 p_type 이 text 인 것은 'entry'/'exit' 이 enum 타입이 아니기 때문이다 — 대비 사례.)
--
-- [해제는 p_track => null] 별도 함수/별도 인자를 만들지 않는다. NULL 은 이미 정의된 도메인 상태다
--   (계열 미선택 -> 홈 추천 최신순 fallback). >>> 프런트는 키를 생략하지 말고 명시적으로 null 을 보낼 것.
--
-- [전환 함수와 합치지 않는다] 권한 표면이 다르다. 합치면 계열 저장 호출이 잔액 로직을 지나가고,
--   한쪽의 버그가 다른 쪽 컬럼에 도달할 수 있다(ADR 0007 결정 4-2).
--
-- [반환] { ok:true, career_interest } — 프런트가 AuthContext 를 즉시 갱신한다. 갱신하지 않으면 학생 홈의
--   [profile] 의존 useEffect 가 재실행되지 않아 "계열을 바꿨는데 추천이 안 바뀌는" 상태가 된다.
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
  '[ADR 0007] 학생 본인의 관심 진로 계열 저장/해제(p_track => null 이 해제). '
  'profiles 에 update 정책을 열지 않고 이 함수 하나로만 연다 — 정책을 열면(설령 컬럼 grant 를 함께 걸어도) '
  '보안 성질이 grant 한 줄에 얹혀 fail-open 이 된다(ADR 0007 결정 4-3). '
  'UPDATE SET 목록이 career_interest 하나뿐이라는 것이 컬럼 경계의 전부다. 인자 타입이 enum 이라 '
  '5종/NULL 외의 값은 캐스팅 단계(22P02)에서 걸러진다. 관리자는 호출할 수 없다.';

revoke all on function public.set_career_interest(public.career_track) from public;
grant execute on function public.set_career_interest(public.career_track) to authenticated;

-- =========================================================
-- 6. 시연 리셋 절차 갱신 (ADR 0007 구현 가이드 6번)
--
-- [★ currency_balance 초기화가 새로 필요하다] 빠뜨리면 리셋 후에도 "전환한 지역화폐 N원" 이 화면에 남는다.
--   reviews 는 participation_id 의 on delete cascade 로 함께 삭제되므로 별도 delete 문이 필요 없다.
-- =========================================================
comment on table public.participations is
  '학생의 프로그램 신청/참여 행. applied(신청) -> entered(입장 인증) -> completed(퇴장 인증 + 포인트 지급). '
  '[시연 리셋] 아래 2문장을 함께 실행해야 포인트 정합이 맞는다 (service_role 로 실행): '
  '  delete from public.participations;  -- point_transactions 와 reviews 가 on delete cascade 로 함께 지워진다 '
  '  update public.profiles set points_balance = 0, points_total = 0, currency_balance = 0; '
  '  >>> [ADR 0007] currency_balance 초기화가 새로 필요하다 — 빠뜨리면 리셋 후에도 "전환한 지역화폐" 가 남는다.';

-- =========================================================
-- 적용 후 확인 (anon 키 + 실제 계정으로. service_role 로 확인하면 RLS 를 우회해 아무것도 검증되지 않는다)
--
--  [원장]
--   1) 학생 A: select * from point_transactions -> 본인 행만. 학생 B 행 0건
--   2) 관리자: select * from point_transactions -> 0행
--   3) 학생: insert into point_transactions {...} -> 42501/403
--
--  [profiles 직접 쓰기 — 전부 0행이어야 한다]
--   4) 학생: update profiles set points_balance = 999999 -> 0행
--   5) 학생: update profiles set career_interest = 'it'  -> 0행 (정책 0개. RPC 로만 바뀐다)
--
--  [전환 RPC]
--   6) p_amount = 잔액 + 10 -> { ok:false, reason:'insufficient_balance' } (403 이 아니어야 한다)
--   7) ★ p_amount = -1000 -> 22023 이고, 이후 points_balance 가 "늘지 않았는지" 반드시 확인할 것.
--          늘었다면 (2)단계 금액 검증이 빠진 것이다 = 이번 구현 최대의 함정.
--   8) p_amount = 11 / 50 / 0 / null -> 전부 22023
--   9) 정상 전환 1회 -> points_balance 감소 / currency_balance 증가 / points_total 불변 /
--                       원장에 '전환' 1행 + related_participation_id is null
--  10) 두 세션에서 거의 동시에 전액 전환 -> 정확히 1건만 성공, points_balance >= 0
--  11) 관리자가 호출 -> 42501/403
--
--  [계열 RPC]
--  12) p_track='it' -> 성공. DB 에서 points_*/currency_balance/role/code/name 이 전부 불변인지 직접 확인
--  13) p_track=null -> 해제(NULL)
--  14) p_track='med' -> 22P02/400 (함수 본문에 도달하지 않는다)
--  15) 관리자가 호출 -> 42501/403
--
--  [reviews]
--  16) 본인 completed 참여에 insert -> 성공 / 같은 참여 재insert -> 23505
--  17) 본인 applied/entered 참여에 insert -> 42501/403
--  18) 남의 participation_id 로 insert -> 42501/403
--  19) update set participation_id = 다른 참여 -> 42501/403 (컬럼 grant) / set rating = 5 -> 성공
--  20) insert 에 id 또는 created_at 포함 -> 42501/403 (컬럼 grant)
--  21) 학생 A: select * from reviews -> 본인 것만 / ★ 관리자: 0행 (담당 학생 것도 안 보여야 한다)
--  22) delete from reviews -> 0행/403
--  23) rating = 0 / 6, 61자 comment -> 23514
--
--  [회귀 — 이번 변경이 기존 경계를 깨지 않았는가]
--  24) 관리자가 insert into participations {student_id: 본인} -> 여전히 42501/403 (무한 적립 폐루프 차단 생존)
--  25) QR 발급 -> 입장 인증 -> 퇴장 인증 -> 포인트 지급 전 구간이 그대로 동작
--  26) 정원 1짜리 프로그램의 두 번째 신청이 P0001/capacity_full 로 차단(ADR 0006)
--  27) anon 키로 두 RPC 호출 -> 거부
--
-- [검증 데이터 정리] 시연용 DB 다. 테스트로 만든 participations / programs / reviews 행은 service_role 로 지우고,
--   profiles 의 points_balance / points_total / currency_balance 를 스냅샷으로 되돌릴 것.
--   >>> currency_balance 복원을 빠뜨리지 말 것. 이번에 처음 생긴 컬럼 경로다.
-- =========================================================
