# ADR 0007: 포인트 원장 조회 · 만족도 평가(reviews) · 지역화폐 전환 · 관심 계열 저장

## 상태

확정

## 배경

`docs/specs/student-archive-mypage.md`(2026-07-30, 케빈 확정: **K-1 / L-1 / M-1**)의 "데이터/백엔드 영향" 절 1~4번을 DB 경계로 옮긴다. 스펙의 결정(A~J)과 확정 3건은 **재논의하지 않는다.**

이 ADR은 ADR 0005가 **"다음 스펙 몫"으로 명시적으로 예약해둔 4칸을 전부 회수한다.**

| # | 대상 | ADR 0005가 남긴 문장 |
|---|---|---|
| 1 | `point_transactions_select_own` | "마이페이지 스펙에서 `point_transactions_select_own`을 열 자리" (결정 2-1 / "RLS 영향") |
| 2 | `reviews` 테이블 | "확정 B-1이 미뤘다. 아카이브 스펙에서 함께 만든다" ("향후 변경") |
| 3 | 포인트 → 지역화폐 전환 | "차감도 `profiles` update이므로 이번과 같은 definer RPC가 필요하다(update 정책을 열지 말 것)" |
| 4 | `career_interest` 저장 | "**절대** `for update using (id = auth.uid())`만 여는 것으로 끝내지 말 것(`points_*`가 함께 열린다)" |

### 이 변경의 성격 — 무게중심은 3번이다

지금까지 학생이 DB에 쓰는 경로는 **`participations` insert(컬럼 2개) + `issue_participation_qr()`** 둘뿐이었고, `profiles`를 바꾸는 경로는 **`verify_participation_qr()` 하나뿐**이었다. 이번에 다음 셋이 처음 열린다.

- **잔액을 줄이는 최초의 경로** (전환)
- **`currency_balance`를 건드리는 최초의 코드** (절대 원칙 3의 첫 구현)
- **학생이 자기 `profiles`를 바꾸는 최초의 경로** (계열)

즉 이 ADR의 실질은 화면이 아니라 **"`profiles`에 두 번째·세 번째 writer가 생기는데 update 정책은 계속 0개로 둘 수 있는가"**이고, 답은 **그렇다**이다(결정 3·4).

### 이 ADR이 의존하는 확정 절 (재논의 대상 아님)

| 절 | 내용 | 이 ADR에서의 역할 |
|---|---|---|
| 0005 결정 2-1 | `profiles` update 정책 0개 / `participations` update·delete 정책 0개 / `point_transactions` 정책 0개 | 셋 중 앞의 둘은 **그대로 유지**하고, 셋째만 select 1개를 연다 |
| 0005 결정 2-2 | RLS로 표현할 수 없는 것 5가지(컬럼 경계·인자·남의 행·원자성·사유 구분) | 4건 각각의 "정책 vs RPC" 판단 기준 |
| 0005 결정 2-5 | `security definer` 취급 5원칙 | 신규 함수 2개에 전부 적용 |
| 0005 결정 3-1 | `point_transactions` CHECK (`'전환'` ⇒ `related_participation_id is null`) | **한 글자도 고치지 않는다.** 전환 RPC가 이 CHECK를 만족시키는 쪽이다 |
| 0005 결정 3-2 | `point_transaction_type`에 `'전환'`이 정의만 되어 있음 | 이번에 **처음으로 생성된다** |
| 0005 결정 3-4 | `profiles.points_*`를 늘리는 유일한 경로 = `verify_participation_qr()` | **문장 단위로 개정한다** — 아래 결정 3-6 |
| 0005 결정 3-6 | 표시할 금액은 `programs.points`가 아니라 `point_transactions.amount` | 1번 정책이 이것을 **처음으로 가능하게 만든다**(확정 L-1) |
| 0005 결정 6-1(b) | `participations_insert_own`의 `not public.is_admin()` — 관리자 무한 적립 폐루프 차단 | **건드리지 않는다.** 영향 확인은 결정 6-2 |
| 0005 결정 6-2 | 컬럼 단위 insert grant (fail-closed 규율) | `reviews`에 같은 규율을 적용 — 단 **의미가 다르다**(결정 2-4) |
| 0005 결정 7-2(c) | 컬럼 grant로 `profiles`를 좁힐 수 없다(학생·관리자가 같은 DB 역할) | 결정 4-3에서 **정확히 어디까지 참인지** 따진다 |
| 0006 결정 1-3(a) | 진짜 규칙은 "쓰기는 전부 RPC"가 아니라 **"RLS로 표현할 수 없는 쓰기가 RPC"** | 4건을 각각 이 기준으로 판정(결정 0) |
| 0006 결정 8 | 새 인덱스를 추가하지 않는다. 예외는 "제약의 부산물"뿐 | 결정 5 |

### 이 ADR이 개정하는 것 (문장 단위)

1. **ADR 0005 결정 3-4** — "`profiles.points_*`를 늘리는 유일한 경로" → **"늘리는" 경로는 그대로, "줄이는" 경로가 하나 추가된다.** 결정 3-6.
2. **ADR 0005 "향후 변경"의 3개 항목**(`reviews` / 마이페이지·전환 / `profiles` 본인 수정) — 본 ADR로 회수됐음을 표기.
3. **`docs/db/schema.sql` 주석 4곳** — `point_transaction_type`(전환이 생성된다) / `profiles` 165~172줄 블록(계열 수정 경로 확정) / `profiles.points_balance`(writer 표) / 시연 리셋 절차(`currency_balance` 추가).

**개정하지 않는 것 (명시)**: 0005 결정 2-1의 나머지, 결정 3-1의 CHECK, 결정 3-3(멱등 구조), 결정 5(StackViz 소스·가드), 결정 6-1~6-3(신청 정책 9절 + 컬럼 grant), 결정 7 전체(관리자 경계), 0006 전체(정원 게이트). **`issue_participation_qr()` / `verify_participation_qr()` / `participations_insert_own` / `participations_capacity_guard()`는 한 글자도 수정하지 않는다.**

---

## 결정 0 — 4건을 "정책 vs 트리거 vs RPC"로 먼저 판정한다

ADR 0006이 정밀화한 기준(**RLS로 표현할 수 없는 쓰기만 RPC**)을 4건에 각각 적용한 결과다. 결론을 먼저 놓는다.

| # | 대상 | 판정 | 결정적 사유 |
|---|---|---|---|
| 1 | 포인트 내역 조회 | **RLS 정책 1개** | 조회다. `student_id = auth.uid()` 한 줄로 경계가 완전히 표현된다. "조회는 RLS"의 교과서 사례 |
| 2 | 리뷰 작성·수정 | **RLS 정책 3개 + 컬럼 grant** | 아래 표에서 5가지 사유 중 **0개** 해당. 단일 행 쓰기이고 경계("완료된 본인 참여")가 `exists` 서브쿼리로 **정확히 표현된다** |
| 3 | 지역화폐 전환 | **`security definer` RPC** | 5가지 중 **4개** 해당(남의 컬럼 경계·원자성·사유 구분·`profiles` 쓰기). 선택지가 없다 |
| 4 | 관심 계열 저장 | **`security definer` RPC** | 5가지 중 1개(컬럼 경계) 해당. **그러나 그 1개가 `profiles`에서는 치명적이다** — 아래 결정 4 |

**결정 2-2의 5가지 사유를 4건에 대입한 표** (ADR 0006 결정 1-3(a)와 같은 형식):

| 사유 | 1 원장 조회 | 2 리뷰 | 3 전환 | 4 계열 |
|---|---|---|---|---|
| RLS는 컬럼 단위가 아니다 | — (조회) | **아니다** — 컬럼 grant가 2차로 봉인 | **그렇다** | **그렇다** ← 유일 |
| 정책 표현식에 인자를 넘길 수 없다 | 아니다 | 아니다 | **그렇다**(금액) | 아니다 |
| 남의 행을 수정해야 한다 | 아니다 | 아니다 | 아니다(본인 행) | 아니다 |
| 원자성(여러 쓰기가 한 트랜잭션) | 아니다 | 아니다(쓰기 1행) | **그렇다**(3개 쓰기) | 아니다 |
| 거부 사유 구분 | 아니다 | 아니다 | **그렇다**(잔액 부족 ≠ 권한) | 아니다 |

→ 2번이 RPC가 아닌 것과 4번이 RPC인 것이 이 표의 결론이다. **트리거는 4건 어디에도 쓰지 않는다** — ADR 0006이 트리거를 택한 이유는 "교차 행 제약"이었는데(정원), 이번 4건에는 교차 행 규칙이 하나도 없다.

---

## 결정 1 — `point_transactions_select_own` (스펙 1번)

### 1-1. 정책

```sql
create policy "point_transactions_select_own"
  on public.point_transactions
  for select
  to authenticated
  using (student_id = auth.uid());
```

**이 테이블의 정책은 앞으로도 이 1개뿐이다.** insert / update / delete 정책은 **0개를 유지**한다 — 학생이 원장에 직접 쓸 수 있으면 포인트를 스스로 찍어낼 수 있고, 그건 이 테이블이 막으려던 바로 그 공격이다(0005 결정 3-1).

### 1-2. 컬럼 노출 범위 — 전부 열리고, 그래도 안전하다

RLS는 행 단위이므로 보이는 행의 **모든 컬럼**(`id, student_id, type, amount, related_participation_id, created_at`)이 열린다. 검토 결과 노출 문제가 없다:

- `student_id`는 언제나 `auth.uid()` 자신이다.
- `related_participation_id`는 **반드시 그 학생 본인의 참여**를 가리킨다. 유일한 생성자인 `verify_participation_qr()`이 `(v_p.student_id, '적립', v_points, v_p.id)`로 같은 행에서 둘을 함께 꺼내 쓰기 때문에 구조적으로 남의 참여 id가 들어갈 수 없다. 전환 행은 NULL이다(CHECK).
- `amount`는 본인이 받은 금액이다.

→ **다른 학생에 대한 정보가 한 컬럼도 없다.** 컬럼 grant로 좁힐 이유가 없다.

### 1-3. 관리자에게는 열지 않는다 (확정 재확인, 뒤집지 않음)

`docs/specs/admin-students.md` 결정 D가 **"관리자 아카이브에 포인트를 표시하지 않는다"**로 확정했고 그 근거가 정확히 "원장 테이블을 관리자에게 처음 여는 결정을 하지 않는다"였다. **이 ADR은 그 문을 열지 않는다.**

- 관리자 전용 정책을 만들지 않는다. 위 정책 하나뿐이므로 관리자가 `select * from point_transactions`를 쏘면 **`student_id = auth.uid()`로 평가되어 본인 행만** 나온다.
- 그리고 **관리자에게는 적립 행이 존재할 수 없다.** `participations_insert_own`의 `not public.is_admin()`(0005 결정 6-1(b)) 때문에 관리자는 참여 행을 만들 수 없고, 적립은 참여에서만 나온다(CHECK). 전환도 결정 3-2에서 관리자를 막는다.
- → **관리자 계정의 조회 결과는 항상 0행이다.** 인수 조건 8번("관리자로 select → 0행 또는 403")이 정책 하나로 성립한다.

### 1-4. 이 정책이 만드는 화면 기능 (확정 L-1의 전제)

확정 L-1(아카이브 활동 행에 작은 amber 포인트, PDF에는 제외)은 **표시값의 소스가 `point_transactions.amount`**여야 한다(0005 결정 3-6). 관리자 아카이브가 포인트를 표시할 수 없었던 이유(원장을 못 읽는다)가 학생 화면에서는 이 정책으로 사라진다.
→ **`programs.points`를 아카이브·내역에 쓰지 말 것.** 관리자가 프로그램 포인트를 수정해도 이미 지급된 금액은 변하면 안 된다(인수 조건 4번이 이것을 실증한다).

---

## 결정 2 — `reviews` 테이블 (스펙 2번)

### 2-1. 스키마

CLAUDE.md 5장 필드(`id, participation_id, rating, comment`) + 프로젝트 전례상 `created_at`. **그 외 컬럼을 추가하지 않는다.**

| 컬럼 | 타입 | 제약 |
|---|---|---|
| `id` | uuid | PK, `default gen_random_uuid()` |
| `participation_id` | uuid | not null, **unique**, → `participations(id)` **on delete cascade** |
| `rating` | integer | not null, `check (rating between 1 and 5)` |
| `comment` | text | nullable, `check (comment is null or char_length(comment) <= 60)` |
| `created_at` | timestamptz | not null default now() |

- **`student_id`를 비정규화하지 않는다.** 소유자는 `participation_id`를 통해 유일하게 결정되고, 컬럼을 두면 `participations.student_id`와 어긋날 자리가 생긴다(0005가 `participations.points_awarded` 스냅샷 컬럼을 기각한 것과 같은 논리). 정책의 `exists` 서브쿼리가 그 역할을 한다.
- **`updated_at`을 만들지 않는다.** 수정은 허용하지만 화면 어디에도 "수정됨" 표시가 없다(스펙 D-4). 쓰이지 않는 컬럼을 만들지 않는다.
- **`rating`은 `integer`** — `smallint`로 좁히면 이 스키마에서 유일한 정수 타입 예외가 된다. `check`가 실질 범위를 정한다.
- **`comment` 상한 60자를 DB에도 건다.** 프런트 `maxlength=60`은 우회 가능하다(스펙 2번 요구). 빈 문자열은 CHECK로 막지 않는다 — 대신 **프런트가 빈 값을 `null`로 보내는 규율**을 진다(`''`을 23514로 튕기면 정상 UI에서 발생하는 오류가 생긴다).
- **`on delete cascade`** — 시연 리셋(`delete from participations`)이 리뷰를 함께 지운다. 참여는 없는데 리뷰만 남는 상태를 만들지 않는다(`point_transactions.related_participation_id` 전례 그대로).

### 2-2. 정책 3개 (select / insert / update). **delete는 0개**

```sql
-- 읽기: 본인 참여의 리뷰만
create policy "reviews_select_own" on public.reviews for select to authenticated
  using (exists (
    select 1 from public.participations p
     where p.id = reviews.participation_id
       and p.student_id = auth.uid()          -- ★ 이 절이 관리자 차단의 전부다
  ));

-- 작성: 완료된 본인 참여에만
create policy "reviews_insert_own" on public.reviews for insert to authenticated
  with check (exists (
    select 1 from public.participations p
     where p.id = reviews.participation_id
       and p.student_id = auth.uid()
       and p.status = 'completed'
  ));

-- 수정: using(OLD) / with check(NEW) 양쪽에 같은 조건
create policy "reviews_update_own" on public.reviews for update to authenticated
  using      (exists (... p.student_id = auth.uid() and p.status = 'completed'))
  with check (exists (... p.student_id = auth.uid() and p.status = 'completed'));
```

### 2-3. **[가장 위험한 지점] `p.student_id = auth.uid()`를 "RLS가 어차피 막아준다"며 지우지 말 것**

정책 표현식 안의 서브쿼리는 **질의자 권한으로 평가되므로 `participations`의 RLS를 탄다.** 그리고 관리자에게는 `participations_select_mentored_as_admin`(담당 5명의 `completed`)이 열려 있다. 따라서:

> `exists (select 1 from public.participations p where p.id = reviews.participation_id)`
> 로 "단순화"하는 순간 **관리자가 담당 학생 5명의 리뷰를 전부 읽는다.** 스펙 결정 E("본인만 읽는다. 관리자도 못 읽는다")가 통째로 무너진다.

이것은 ADR 0005 결정 6-3이 `p.is_published = true`에서 이미 한 번 확인한 함정과 **정확히 같은 계열**이다(정책 서브쿼리가 다른 정책 덕에 더 넓게 보이게 되는 현상). 그때와 같은 처방을 쓴다 — **경계를 명시적으로 다시 건다.** 마이그레이션 주석에 이 문장을 남길 것.

부수 효과로 이 절은 학생 ↔ 학생도 막고, 리뷰가 아예 **집계될 수 없게** 만든다: 평균 별점·리뷰 수·인기 정렬은 UI 규율이 아니라 **RLS 구조로** 불가능하다(스펙 원칙 1 가드).

### 2-4. 컬럼 단위 grant — `participation_id` 이동을 **trigger 없이** 막는다

```sql
revoke insert, update on public.reviews from authenticated;
revoke insert, update on public.reviews from anon;
grant insert (participation_id, rating, comment) on public.reviews to authenticated;
grant update (rating, comment)                   on public.reviews to authenticated;
```

- **update grant에 `participation_id`가 없다** → 학생은 `set participation_id = ...`를 **문장에 쓸 수조차 없다**. 스펙 2번의 "`participation_id`를 다른 참여로 옮길 수 없어야 한다"가 이 한 줄로 성립한다.
  - RLS만으로는 여기까지 못 간다: `with check`는 NEW만 보므로 "**본인의 다른** 완료 참여로 옮기기"를 막지 못한다(OLD/NEW를 연결할 수단이 없다 — 0005 결정 2-2-1). `before update` 트리거(`new.participation_id = old.participation_id` 강제)도 검토했으나, 컬럼 grant가 같은 결과를 **함수 0개**로 낸다.
- **insert grant에 `id` / `created_at`이 없다** → 0005 결정 6-2가 `participations`에서 닫은 틈(`id` 지정 / `created_at` 위조)이 새 테이블에서도 처음부터 닫힌다. 앞으로 `reviews`에 컬럼이 늘어도 학생은 쓸 수 없다(fail-closed).
- **`select`는 회수하지 않는다.** 행 경계는 정책이 소유하고, 컬럼은 전부 본인 데이터다(결정 1-2와 같은 판단).
- **`delete`는 grant를 건드리지 않는다.** 정책 0개가 경계다(`participations` 전례 그대로). → 아래 결정 4-4의 규율("grant 조작은 무언가를 돌려줄 때만 한다")과 일치한다.

### 2-5. 경계가 성립하는지 확인한 항목

| 확인 | 결과 |
|---|---|
| 학생 A가 학생 B의 `participation_id`로 작성 | `p.student_id = auth.uid()` 불일치 → 42501 |
| 학생이 `applied`/`entered` 참여에 작성 | `p.status = 'completed'` 불일치 → 42501 |
| 같은 참여에 2행 | `unique (participation_id)` → 23505. 프런트가 update 경로로 전환 |
| 관리자가 읽기 | 결정 2-3 → **0행** |
| 리뷰 삭제 | 정책 0개 → 0행/403 |
| 리뷰 작성이 `participations`를 건드리는가 | **아니다.** 트리거 0개, `participations` update 정책 0개 유지. 서브쿼리는 읽기만 한다 |
| 리뷰 작성이 포인트를 늘리는가 | **아니다.** `point_transactions`에 어떤 경로도 만들지 않는다(스펙 원칙 1 가드) |
| **정책 재귀** | 없음. 참조 방향이 `reviews → participations → {programs, mentor_students}`로 **단방향**이다. **어떤 `participations` 정책에서도 `reviews`를 참조하지 말 것** — 그 순간 순환이 된다(0005 결정 7-2(a)와 같은 규율) |
| 게시중단된 프로그램의 완료 건에 평가 | **가능하다.** 경계가 `participations`이지 `programs`가 아니고, `participations_select_own`에 `is_published` 조건이 없다. 스펙 방어적 렌더 요구와 일치 |
| `participations_insert_own` 재검토 필요 여부 | **없다.** `participations`에 컬럼을 추가하지 않았다(스펙 이슈 6). 별도 테이블을 택한 부수 이득이 실제로 발생했다 |

---

## 결정 3 — 지역화폐 전환 RPC (스펙 3번, 절대 원칙 3의 첫 구현)

### 3-1. 함수 시그니처 · 반환 형태 (backend가 그대로 구현할 것)

```
public.convert_points_to_currency(p_amount integer) returns jsonb
  language plpgsql | volatile | security definer | set search_path = ''
  revoke all on function ... from public;
  grant execute on function ... to authenticated;

  [예외 — 권한/인자. 도메인 실패와 절대 섞지 않는다]
    42501  auth.uid() is null                     '인증되지 않은 호출입니다.'
    42501  public.is_admin()                      '학생만 호출할 수 있습니다.'
    42501  본인 profiles 행 없음                   '프로필을 찾을 수 없습니다.'
    22023  p_amount is null / <= 0 / % 10 <> 0 / < 100
                                                  '전환 금액이 올바르지 않습니다.'   (PostgREST -> HTTP 400)

  [반환 — 도메인 결과]
    실패: { ok:false, reason:'insufficient_balance',
            points_balance, points_total, currency_balance }      <- 최신 잔액을 함께 준다
    성공: { ok:true, amount, points_balance, points_total, currency_balance, at }

  [본문 실행 순서]
    1) v_student := auth.uid();  null 이면 42501
    2) if public.is_admin() then 42501                      (3-2)
    3) 금액 검증: p_amount > 0  and  p_amount % 10 = 0  and  p_amount >= 100
       -> 위반 시 22023.  ★ 이 절은 UX 검증이 아니라 보안 경계다 (3-4)
    4) update public.profiles
          set points_balance   = points_balance   - p_amount,
              currency_balance = currency_balance + p_amount
        where id = v_student
          and points_balance >= p_amount                    -- ★ CAS. 음수 방지 + 동시성 방어
        returning points_balance, points_total, currency_balance into ...;
       ※ SET 목록에 points_total / role / code / name / career_interest 가 없다 (3-6)
    5) if not found then
         select 잔액 3종 into ... from public.profiles where id = v_student;
         if not found then 42501 end if;                    -- 프로필 자체가 없음
         return { ok:false, reason:'insufficient_balance', ...잔액 }
       end if;
    6) insert into public.point_transactions
            (student_id, type, amount, related_participation_id)
       values (v_student, '전환', p_amount, null);          -- related 는 NULL (CHECK 가 요구)
    7) return { ok:true, ... }
```

**`related_participation_id`는 명시적으로 `null`을 쓴다.** 0005 결정 3-1의 CHECK(`type='전환'` ⇒ `related is null`)를 **수정하지 않는다** — 함수가 CHECK를 만족시키는 쪽이다.

### 3-2. 호출자 경계: 학생 본인만. 관리자는 42501

- 함수가 `student_id`를 **인자로 받지 않는다** → 남의 잔액을 전환할 경로가 구조적으로 없다(0005 결정 2-3과 같은 형태의 방어).
- `not is_admin()`은 도메인 규칙이다 — 관리자는 참여할 수 없으므로 잔액이 언제나 0이고, 포인트/지역화폐는 학생의 도메인이다(CLAUDE.md 4장). 보안상 필수는 아니지만 **"관리자는 포인트 도메인 밖"이라는 불변식을 명시적으로 남기는 값이 더 크다.** 인수 조건 8번("전환 RPC를 관리자 계정으로 호출 → 거부")을 그대로 만족한다.

### 3-3. 동시성·음수 방지: **조건부 UPDATE 한 문장이 둘 다 해결한다** (`for update` 불필요)

```sql
update ... where id = v_student and points_balance >= p_amount
```

- **음수 방지**: `p_amount > 0`(3단계)과 `points_balance >= p_amount`(WHERE)가 함께 성립하면 결과는 반드시 `>= 0`이다. 프런트 조건문이 아니라 **DB 문장이 판정한다**(요구 3-b).
- **동시성**: 같은 행에 동시에 도착한 두 UPDATE 중 두 번째는 행 잠금에서 대기하고, **READ COMMITTED는 잠금이 풀린 뒤 갱신된 행 버전으로 WHERE를 다시 평가한다**(EvalPlanQual). 따라서 두 번째는 줄어든 잔액을 보고 0행이 된다. 잔액 1,150P에 1,000P 전환 두 건이 겹치면 **정확히 1건만 성공**한다(요구 3-e).
  → 별도 `select ... for update`를 앞에 두지 않는다. 조건부 UPDATE 자체가 잠금이자 검사다. 이는 0005 결정 3-3의 CAS(`where id = ? and status = '이전 상태'` + 영향 행 검사)와 **완전히 같은 기법**이며, 여기서는 상태 대신 잔액이 조건일 뿐이다.
- **0행 = 도메인 실패**로 다룬다(요구 3-c). `42501`을 던지지 않는다.

### 3-4. **[보안] 금액 검증은 UX가 아니다 — 음수 인자는 포인트 자가 발행 경로다**

`p_amount = -5000`이 3단계를 통과하면 4단계는 이렇게 된다:

```
points_balance = points_balance - (-5000)   -- 5,000P 증가
points_balance >= -5000                     -- 언제나 참
```

**= 학생이 RPC 한 번으로 포인트를 찍어낸다.** 절대 원칙 3과 0005 결정 3-4가 통째로 무너진다. 그래서 `p_amount > 0`은 **이 함수에서 가장 중요한 한 줄**이며, `% 10`·`>= 100`과 달리 **도메인 규칙이 아니라 보안 경계**다. 함수 주석에 이 문장을 남길 것.

**2차 방어가 이미 DB에 있다(확인 완료)**: 3단계를 어떤 이유로 잃더라도 6단계의 원장 insert가 `point_transactions_amount_positive check (amount > 0)`에 걸려 **23514로 튕기고, 같은 트랜잭션인 4단계의 잔액 증가까지 함께 롤백된다.** 0005 결정 3-3이 이중 지급에 세운 것과 같은 "둘 다 DB 제약" 구조가 전환에도 성립한다.
→ 그래서 **원장 insert를 잔액 update보다 뒤에 둔다.** 순서를 바꾸면 이 2차 방어가 사라진다.

**3차 방어(신규)**: `profiles`에 CHECK 제약을 추가한다.

```sql
alter table public.profiles
  add constraint profiles_balances_non_negative
  check (points_balance >= 0 and points_total >= 0 and currency_balance >= 0);
```

- 인덱스가 아니라 제약이므로 ADR 0003/0004의 "인덱스 추가 금지"와 무관하다.
- 앱 전체의 불변식("잔액은 음수가 될 수 없다")이 지금까지 **어디에도 DB로 적혀 있지 않았다.** 잔액을 줄이는 경로가 처음 생기는 이 시점이 그 자리다.
- 기존 데이터는 전부 0 이상이라 적용 시 실패하지 않는다.
- 미래에 어떤 경로가 잔액을 음수로 만들려 해도 트랜잭션이 통째로 실패한다(fail-closed).

### 3-5. 멱등성은 **요구되지 않는다** (QR과 다른 점 — 명시)

전환을 두 번 하면 두 번 차감되는 것이 **정상 도메인**이다(요구 3-f). 그래서:

- `point_transactions`에 전환용 unique 제약을 **만들지 않는다**(만들 수도 없다 — `related_participation_id`가 NULL이다).
- 더블클릭 방어는 **프런트 버튼 잠금**이 담당한다. 서버는 각 호출마다 잔액을 검사하므로 **정합은 어떤 경우에도 깨지지 않는다.**
- 취소·환급 경로를 만들지 않는다(스펙 결정 G). 되돌리려면 원장 역행과 `points_total` 정합 설계가 필요하고, 0005 결정 3-3은 역방향을 상정하지 않는다.

### 3-6. **ADR 0005 결정 3-4의 못을 어떻게 유지하는가** (이 ADR의 핵심 문장)

0005 결정 3-4는 이렇게 적혀 있다: *"`profiles.points_*`를 늘리는 유일한 경로는 `verify_participation_qr()` 안의 update 1개뿐이다."*

**이 문장은 뒤집히지 않는다. 개정되는 것은 범위뿐이다.**

| `profiles` 컬럼 | 증가시키는 경로 | 감소시키는 경로 | update 정책 |
|---|---|---|---|
| `points_balance` | `verify_participation_qr()` **(불변, 유일)** | **`convert_points_to_currency()` (신규, 유일)** | **0개** |
| `points_total` | `verify_participation_qr()` **(불변, 유일)** | **없음 — 영구 누적. 전환이 생겨도 줄지 않는다** | **0개** |
| `currency_balance` | **`convert_points_to_currency()` (신규, 유일)** | 없음 | **0개** |
| `career_interest` | `set_career_interest()` (신규, 유일) | 〃 | **0개** |
| `id / role / code / name` | 없음 (시딩 = `service_role`) | 없음 | **0개** |

개정문(이 표가 곧 새 문장이다):

> **`profiles`를 수정하는 경로는 `security definer` 함수 3개뿐이며, `profiles`의 update 정책은 여전히 0개다.**
> 포인트를 **늘리는** 경로는 `verify_participation_qr()` 하나로 그대로다. 이번에 추가되는 것은 **줄이는** 경로 하나(`convert_points_to_currency()`)와 **계열을 바꾸는** 경로 하나(`set_career_interest()`)이며, 셋 다 정의자 함수 본문의 **UPDATE SET 목록**이 컬럼 경계다(0005 결정 2-3과 같은 형태).

즉 **못이 박힌 자리는 "함수가 하나뿐"이 아니라 "정책이 0개"였다.** 함수가 2개든 3개든, 정책이 0개인 한 학생이 자기 잔액을 손으로 고칠 경로는 존재하지 않는다. 각 함수는 SET 목록에 자기 컬럼만 적는다.

**규율(앞으로 이 표에 줄이 늘 때마다 적용)**: `profiles`에 쓰는 함수를 추가할 때는 (a) SET 목록에 그 기능의 컬럼만 적고, (b) 이 표를 함께 갱신하고, (c) **update 정책을 여는 선택지는 검토 대상이 아니다.**

### 3-7. 절대 원칙 3 준수 확인

- 결제·계좌·외부 API 호출 **0줄**. 함수는 `profiles` 1행 update + `point_transactions` 1행 insert만 한다.
- `currency_balance`는 **표시용 누적 숫자**다. 이 ADR은 그것을 **사용·차감·조회하는 경로를 만들지 않는다.**
- `verify_participation_qr()`을 **수정하지 않는다.** 전환은 완전히 별개 경로다.

---

## 결정 4 — `career_interest` 저장 RPC (스펙 4번). ADR 0005가 경고한 자리

### 4-1. 함수 시그니처 · 반환 형태

```
public.set_career_interest(p_track public.career_track) returns jsonb
  language plpgsql | volatile | security definer | set search_path = ''
  revoke all on function ... from public;
  grant execute on function ... to authenticated;

  [예외]
    42501  auth.uid() is null            '인증되지 않은 호출입니다.'
    42501  public.is_admin()             '학생만 호출할 수 있습니다.'      (요구 4-d)
    42501  update 영향 행 0              '프로필을 찾을 수 없습니다.'
    22P02  p_track 이 career_track 5종이 아님
           -> 함수 본문에 도달하지 못한다. PostgREST 의 인자 캐스팅 단계에서 발생(HTTP 400)

  [반환]  { ok:true, career_interest: 'sci'|'it'|'hum'|'biz'|'art'|null }

  [본문]
    update public.profiles set career_interest = p_track
     where id = auth.uid()
    returning career_interest into v_track;      -- SET 목록에 이 컬럼 하나뿐
```

- **인자 타입을 `text`가 아니라 `career_track` enum으로 둔다.** ADR 0003 결정 3이 "`programs.career_track`과 `profiles.career_interest`가 같은 타입을 공유해 값 공간 일치를 **타입 시스템**이 보장한다"고 정했는데, 인자를 `text`로 받으면 **쓰기 경로에서만 그 보장이 사라진다.** enum 인자면 요구 4-b(5종 또는 NULL만 허용)를 **함수가 검증할 필요조차 없이** DB가 처리한다.
  - 대비: `issue_participation_qr(p_type text)`는 `'entry'/'exit'`이 enum 타입이 아니라서 본문에서 `not in`으로 검사했다. 여기는 진짜 타입이 있으므로 타입을 쓴다.
- **해제(NULL)는 `p_track => null` 호출**이다. 별도 함수·별도 인자를 만들지 않는다. NULL은 이미 정의된 도메인 상태다(계열 미선택 → 홈 추천 최신순 fallback).
- **확정 K-1(단일 유지)이므로 컬럼 타입 변경이 0건이다.** 배열(K-2)이었다면 `profiles` 마이그레이션 + 홈 추천 매칭(`= ANY`) + `ProgramCard` 배지가 함께 회귀 대상이 됐다.

### 4-2. 전환 함수와 **합치지 않는다**

권한 표면이 다르다. 합치면 계열 저장 호출이 잔액 로직을 지나가고, 한쪽의 버그가 다른 쪽 컬럼에 도달할 수 있다. 스펙 4번 함정 3의 지시 그대로이며, 0005가 발급/검증을 분리해 둔 규율과도 같다.

### 4-3. **왜 "정책 + 컬럼 grant"가 아니라 RPC인가 — 정직한 비교**

기각한 안을 정확히 적는다(이 자리가 ADR 0005가 경고한 지점이다).

**안 A**: `create policy profiles_update_own for update using (id = auth.uid()) with check (id = auth.uid())` + `revoke update on public.profiles from authenticated, anon;` + `grant update (career_interest) on public.profiles to authenticated;`

먼저 **기술적으로는 동작한다**는 점을 인정해야 한다. 0005 결정 7-2(c)가 "컬럼 grant로 좁힐 수 없다"고 한 것은 **select** 이야기였다 — 학생은 본인 행의 전 컬럼을 읽어야 하고 관리자는 담당 학생 행을 읽어야 하는데 둘이 같은 DB 역할이라 컬럼을 나눌 수 없다는 뜻이다. **update는 사정이 다르다**: 이 앱에서 `authenticated` 역할이 정당하게 update할 컬럼은 `career_interest` 하나뿐이고, `points_*`를 쓰는 정의자 함수는 소유자(postgres) 권한으로 실행되므로 `authenticated`의 grant와 무관하다. 즉 **역할을 구분할 필요가 없어서 컬럼 grant가 성립한다.**

그럼에도 기각한다. 사유는 셋이다.

**(a) 보안 성질이 정책이 아니라 grant에 얹힌다 = fail-open 구조.**
안 A에서 컬럼 경계를 지키는 것은 정책이 아니라 `grant update (career_interest)` 한 줄이다. 정책 자체는 `id = auth.uid()`, 즉 **"본인 행 전체 수정 허용"**이다. 그런데 grant는 이 프로젝트에서 **가장 잘 뒤집히는 층**이다 — Supabase는 `public` 스키마의 테이블에 `authenticated`로 ALL을 주는 기본 권한을 갖고 있고(0005 결정 6-2가 `participations`에서 `revoke insert`를 해야 했던 이유가 정확히 이것이다), 앞으로 누군가 권한을 재설정하거나 테이블을 다시 만들거나 `grant all`을 한 줄 넣는 순간 **정책은 그대로인 채 문이 활짝 열린다.** 그 문은 `schema.sql` 169줄이 "절대 열지 말 것"이라고 적어둔 문이다.
RPC는 반대다. **정책이 0개면 함수 밖에 update 경로가 아예 없다.** 무엇을 잊어도 열리지 않는다(fail-closed).

**(b) 42501의 출처가 하나 더 늘어난다 — 가장 민감한 테이블에서.**
0005 결정 6-2가 컬럼 grant의 비용으로 명시한 항목이다: grant 위반과 정책 위반이 둘 다 42501이라 "왜 거부됐는가"의 출처가 둘이 된다. `participations`에서는 그 비용을 감수할 이득(앞으로 컬럼이 늘어도 fail-closed)이 있었다. `profiles`에서는 이득이 없다 — 학생이 쓸 컬럼이 하나뿐이고 앞으로 늘 계획도 없다.

**(c) `profiles` 쓰기 규칙이 둘로 갈라진다.**
전환은 원자성 때문에 **반드시** RPC다(결정 0의 표). 계열까지 RPC면 "**`profiles`를 쓰는 것은 정의자 함수뿐**"이라는 규칙이 하나로 유지되고, 결정 3-6의 표가 그 규칙의 전부가 된다. 안 A를 택하면 "포인트는 함수, 계열은 정책"이 되어 다음 사람이 "그럼 이것도 정책으로 열면 되겠네"의 출발점을 갖게 된다.

→ **일반 규율로 승격한다**: **컬럼 단위 grant는 정책이 이미 표현한 경계 위에 얹는 2차 방어로만 쓴다. 그것이 유일한 1차 경계가 되는 설계는 채택하지 않는다.** (그래서 `reviews`에서는 채택했고 — 정책 3개가 이미 행 경계를 완전히 표현한다 — `profiles`에서는 채택하지 않는다.)

### 4-4. `profiles`의 grant는 건드리지 않는다

`revoke update on public.profiles from authenticated`를 방어적으로 넣는 안도 검토했으나 **넣지 않는다.** 정책 0개가 이미 경계이고, revoke를 추가하면 "경계가 정책인가 grant인가"가 흐려진다(위 (b)의 비용을 이득 없이 사는 것이다).
→ **규율: grant/revoke 조작은 "무언가를 돌려줄 때"만 한다.** `participations`(insert 2컬럼)와 `reviews`(insert 3 / update 2컬럼)가 그 경우고, `profiles`는 아무것도 돌려주지 않으므로 해당 없음.

### 4-5. 요구사항 대조

| 요구 | 성립 근거 |
|---|---|
| 4-a `career_interest`만 바뀐다 | UPDATE SET 목록에 그 컬럼 하나뿐. `points_*`/`role`/`code`/`name`/`id`는 **함수 시그니처에도 문장에도 없다** |
| 4-b 5종 또는 NULL | 인자 타입이 `career_track` enum. 그 밖의 값은 캐스팅 단계에서 22P02 |
| 4-c 남의 행 불가 | `where id = auth.uid()`. 함수가 학생 id를 인자로 받지 않는다 |
| 4-d 관리자 경로 없음 | `is_admin()`이면 42501. 관리자 화면에 계열 UI를 만들지 않는다(관리자 기능 3종 밖) |
| 실패를 삼키지 않는다 | `{ok:true, career_interest}` 반환 + 실패는 예외. 프런트가 롤백·사유 표시(스펙 4번 함정 4) |

---

## 결정 5 — 새 인덱스는 `unique (participation_id)` 하나뿐

| 후보 | 판정 |
|---|---|
| `reviews.participation_id` unique | **채택.** "제약의 부산물인 인덱스" 예외(0005 결정 1-5). 막는 것이 실제 사고다 — 한 참여에 리뷰 2행이 생기면 아카이브가 어느 것을 표시할지 정할 수 없다 |
| `point_transactions(student_id)` | **추가하지 않는다.** 마이페이지 원장 조회(`student_id` 필터 + `created_at` 정렬 + `limit 50`)가 부르고 싶어지지만, ADR 0003 주의 4 / 0004 주의 5 / 0006 결정 8의 원칙 그대로다. 데모 전체에서 수십 행이고, 필요한 것은 제약이 아니라 조회 성능이므로 예외에 해당하지 않는다 |
| `point_transactions(created_at)` | 같은 이유로 추가하지 않는다 |
| `reviews(participation_id)` 조회용 별도 인덱스 | unique가 이미 만든다 |

**재검토 조건**: `point_transactions`가 수천 행을 넘을 때. 1인 시연 프로토타입에서는 오지 않는다.

---

## 결정 6 — 기존 경계에 대한 영향 검토 (전부 "영향 없음" 확인)

### 6-1. 시드 · 데이터

**새 시드 0건.** 빈 상태를 그대로 둔다(0005 "케빈 확인 필요" 2번 확정). 리뷰도, 전환 원장도 시드하지 않는다 — 이 화면들의 **빈 상태가 기본 상태**다(스펙 시나리오 0).

### 6-2. **관리자 무한 적립 폐루프(0005 결정 6-1(b)) — 깨지지 않는다 (확인 완료)**

| 폐루프 단계 | 이번 변경의 영향 |
|---|---|
| (1) 고액 프로그램 생성 | 건드리지 않음(`programs` 정책 3개 불변) |
| (2) **자기 이름으로 신청** ← 끊긴 지점 | **`participations_insert_own`을 drop하지도 재생성하지도 않는다.** `not public.is_admin()` 그대로. `participations`에 새 정책·새 트리거·새 컬럼 0개 |
| (3) 자기 QR 발급 | `issue_participation_qr()` 불변 |
| (4) 자기가 스캔해 완료 처리 | `verify_participation_qr()` 불변 |

추가로 이번 변경이 **새 적립 경로를 만들지 않는지** 확인했다:

- `reviews` 쓰기는 `point_transactions`·`profiles`를 건드리지 않는다(트리거 0개). 평가를 남겨도 원장이 늘지 않는다.
- `point_transactions`는 **select 정책만** 열린다. insert 정책은 여전히 0개 = 학생 자가 발행 불가.
- `convert_points_to_currency()`는 잔액을 **줄이는** 함수다. 단 **음수 인자로 늘릴 수 있다** — 결정 3-4에서 3중으로 막았다(금액 검증 / 원장 CHECK + 트랜잭션 롤백 / `profiles` 잔액 CHECK).
- `set_career_interest()`의 SET 목록에 포인트 컬럼이 없다.

→ **"포인트를 늘리는 경로는 여전히 `verify_participation_qr()` 하나뿐"이 유지된다.**

### 6-3. 정원 게이트(ADR 0006) · QR 상태 기계(0005 결정 1·3)

- `participations`에 트리거를 추가하지 않는다. `participations_capacity_guard`는 `before insert`로 그대로다.
- `reviews` 정책의 서브쿼리는 `participations`를 **읽기만** 한다 — 트리거를 발화시키지 않는다.
- QR 함수 2개, 토큰 unique 2개, CAS 구조, 이중 지급 방어 전부 불변.

### 6-4. 게시중단 열화(0005 결정 7-4)

학생 아카이브에서 **실제로 발생하는 경로**지만(스펙 이슈 2) 이번 변경으로 달라지는 것이 없다. 확인한 것: (a) 리뷰 작성 경계가 `participations`라서 게시중단 건에도 평가할 수 있다, (b) 원장의 `amount`는 남아 있으므로 포인트 내역이 영향받지 않는다. 둘 다 스펙 요구와 일치한다.

---

## RLS/권한 영향

### 이번에 열리는 것

| 대상 | 이름 | 종류 | 경계 |
|---|---|---|---|
| `point_transactions` | `point_transactions_select_own` | select | `student_id = auth.uid()` |
| `reviews` | `reviews_select_own` | select | 본인 참여의 리뷰 |
| `reviews` | `reviews_insert_own` | insert | 본인 + `completed` 참여 |
| `reviews` | `reviews_update_own` | update | 〃 (using + with check 양쪽) |

| 함수 | 종류 | execute |
|---|---|---|
| `public.convert_points_to_currency(integer)` | **definer** | `authenticated` (본문에서 학생 본인 확인) |
| `public.set_career_interest(public.career_track)` | **definer** | `authenticated` (본문에서 학생 본인 확인) |

| 그 밖 | 내용 |
|---|---|
| 테이블 | `public.reviews` 신규 1개 |
| 제약 | `reviews` 4개(PK / unique / rating CHECK / comment CHECK) + `profiles_balances_non_negative` 1개 |
| 인덱스 | `reviews` PK + unique 2개(제약의 부산물). **그 외 0개** |
| grant | `reviews` insert/update 컬럼 단위 (revoke 후 되돌려주기) |
| 트리거 | **0개** |
| 시드 | **0건** |

### 이번에도 **닫힌 채로 유지되는** 것 (확인 완료)

| 항목 | 상태 |
|---|---|
| `profiles` update / insert / delete 정책 | **0개 유지.** 이 ADR의 핵심 |
| `participations` update / delete 정책 | **0개 유지** |
| `participations_insert_own` with check 9절 + 컬럼 grant | **SQL 불변.** drop/create 하지 않는다 |
| `point_transactions` insert / update / delete 정책 | **0개 유지** — 학생 자가 발행 차단 |
| `reviews` delete 정책 | **0개** — 삭제 경로 없음 |
| 관리자의 `point_transactions` | **0행** (정책이 본인 축뿐 + 관리자에게는 행 자체가 없다) |
| 관리자의 `reviews` | **0행** (`p.student_id = auth.uid()`) |
| 관리자의 `participations` | **담당 5명의 `completed`뿐**(0005 결정 7-2(d)) — 넓히지 않았다 |
| `programs` 정책 3+1개 | **불변** |
| QR 함수 2개 / 정원 트리거 | **불변** |

### 공격/오작동 경로 대조표 (이번 항목만)

| 경로 | 차단 장치 | 결과 |
|---|---|---|
| 학생 A가 학생 B의 원장 조회 | `point_transactions_select_own` | 0행 |
| 관리자가 담당 학생 원장 조회 | 관리자용 정책 없음 | 0행 |
| 학생이 `point_transactions`에 직접 적립 insert | 정책 0개 | 42501/403 |
| **전환 RPC에 음수 금액** | 금액 검증(`> 0`) + 원장 `amount > 0` CHECK로 트랜잭션 롤백 + `profiles` 잔액 CHECK | 22023 (3중 방어) |
| 전환 RPC에 11P / 50P | 금액 검증(`% 10`, `>= 100`) | 22023 |
| 잔액 초과 전환 | 조건부 UPDATE 0행 | `{ok:false, reason:'insufficient_balance'}` (403 아님) |
| 같은 잔액에 동시 전환 2건 | 조건부 UPDATE + READ COMMITTED 재평가 | 정확히 1건 성공, 잔액 음수 불가 |
| 전환으로 `points_total` 감소 | SET 목록에 없음 | 경로 자체가 없음 |
| 전환 원장에 `related_participation_id` 심기 | 함수가 명시적 NULL + CHECK | 불가능 |
| 관리자가 전환 RPC 호출 | 본문 `is_admin()` | 42501/403 |
| 학생이 `update profiles set points_balance = 999999` | update 정책 0개 | 0행 |
| 학생이 `update profiles set career_interest = 'it'` (직접) | update 정책 0개 | 0행 |
| 계열 RPC로 다른 컬럼 수정 시도 | 인자·SET 목록에 없음 | 경로 자체가 없음 |
| 계열 RPC에 없는 값(`'med'`) | 인자 타입 `career_track` | 22P02/400 |
| 남의 계열 변경 | `where id = auth.uid()` | 경로 자체가 없음 |
| 학생 A가 B의 참여에 리뷰 작성 | `reviews_insert_own`의 `p.student_id = auth.uid()` | 42501/403 |
| 미완료 참여에 리뷰 작성 | `p.status = 'completed'` | 42501/403 |
| 같은 참여에 리뷰 2행 | `unique (participation_id)` | 23505/409 |
| 리뷰의 `participation_id`를 다른 참여로 이동 | update 컬럼 grant에 없음 | 42501/403 |
| 리뷰 삭제 | 정책 0개 | 0행/403 |
| **관리자가 담당 학생 리뷰 열람** | `p.student_id = auth.uid()` (RLS 단독에 기대지 않음) | 0행 |
| 리뷰 작성으로 참여 상태·포인트 변경 | 트리거 0개 / 정책 0개 | 경로 자체가 없음 |
| `rating = 0` / `6` | CHECK | 23514/400 |
| 61자 한줄평 | CHECK | 23514/400 |
| anon 키로 두 RPC 호출 | `revoke execute from public` + `auth.uid()` null | 403 |

---

## 대안으로 고려했던 것

- **`reviews` 대신 `participations`에 `rating`/`comment` 컬럼 추가**: `participations_insert_own`의 with check 9절을 재검토·재작성해야 한다(0005가 "한 절만 빠져도 관리자 무한 적립이 열린다"고 적어둔 정책이다). 게다가 학생이 리뷰를 쓰려면 `participations`에 **update 정책을 열어야 하고**, 그건 QR 2회 인증의 상태 기계를 통째로 여는 것이다. **기각**(스펙 이슈 6과 동일 결론).
- **리뷰 작성을 `security definer` RPC로**: 결정 2-2의 5가지 사유 중 **0개** 해당. RPC로 옮기면 정렬·조회까지 함수로 끌려가고 "조회는 RLS" 구조가 깨진다. **기각**(결정 0).
- **`reviews`에 `student_id` 비정규화 + 그 컬럼으로 정책 작성**: 정책이 단순해지지만 `participations.student_id`와 어긋날 자리가 생기고, 정합을 지키려면 트리거가 또 필요하다. 파생 가능한 값을 중복 저장하지 않는다(0005가 `*_token_used_at`을 기각한 것과 같은 논리). **기각.**
- **`reviews`의 `participation_id` 이동을 `before update` 트리거로 봉인**: 동작하지만 컬럼 grant가 함수 0개로 같은 결과를 낸다. **기각**(결정 2-4).
- **`reviews_select_own`을 `exists(participations where id = ...)`로 단순화**(RLS가 알아서 막을 것이라 기대): **관리자에게 담당 학생 5명의 리뷰가 전부 새는 설계다.** 0005 결정 6-3이 확인한 함정과 같은 계열. **기각**(결정 2-3).
- **전환을 정책 + 컬럼 grant로**: 원자성(3개 쓰기)·거부 사유 구분·`point_transactions` 동시 insert를 정책으로 표현할 수 없다. **기각.**
- **전환에서 `select ... for update` 후 비교 후 update**: 조건부 UPDATE 한 문장이 같은 보장을 준다(READ COMMITTED 재평가). 문장이 둘이면 그 사이에 로직이 끼어들 자리가 생긴다. **기각**(결정 3-3).
- **전환에 advisory lock / serializable 격리**: ADR 0006 결정 4-3과 같은 이유로 기각. 잠글 자연스러운 행(본인 `profiles` 행)이 이미 update 문에 있다.
- **잔액 부족을 예외(`P0001` + hint)로**: ADR 0006의 정원 거부가 그 형식을 썼지만, **그건 트리거라 반환값을 가질 수 없었기 때문**이다. RPC는 반환값을 가질 수 있고, 0005 결정 4의 규율(도메인 실패 = 반환값)이 더 직접적인 전례다. 게다가 실패 응답에 **최신 잔액을 함께 실어야** 스펙 시나리오 4("화면의 잔액이 최신 값으로 갱신된다")가 성립하는데, 예외는 데이터를 실을 자리가 없다. **기각.**
- **금액 규칙 위반을 `{ok:false, reason:'invalid_amount'}`로**: 반환값 하나로 통일되어 프런트가 단순해지지만, `issue_participation_qr(p_type)`이 잘못된 인자를 `22023` 예외로 처리한 전례가 있다. **인자 오류는 도메인 결과가 아니다**(정상 UI에서 발생하지 않는다 = 우회 시도 또는 버그 신호). 전례를 따른다. **기각.**
- **전환과 계열 저장을 한 함수로**(`update_my_profile(p_amount, p_track)`): 권한 표면이 다른 두 기능이 한 문장을 공유하게 된다. **기각**(스펙 4번 함정 3).
- **계열 저장을 `profiles` update 정책 + `grant update (career_interest)`로**: 기술적으로 동작하지만 보안 성질이 grant에 얹혀 fail-open이 되고, 42501 출처가 늘고, `profiles` 쓰기 규칙이 둘로 갈라진다. **기각**(결정 4-3 — 이 ADR에서 가장 오래 검토한 항목).
- **`revoke update on public.profiles from authenticated`를 방어적으로 추가**: 정책 0개가 이미 경계이고, 경계의 소재를 흐린다. **기각**(결정 4-4).
- **계열 RPC 인자를 `text`로 받고 본문에서 5종 검증**: enum 타입이 존재하는데 값 목록을 두 번째 장소에 다시 적는 것이다(ADR 0003이 타입 공유로 없앤 드리프트를 되살린다). **기각**(결정 4-1).
- **계열 다중 선택(`career_track[]`)**: 확정 K-1이 단일로 확정. backend 변경이 0건이 되고 홈 추천 회귀도 없다. **기각(확정 사항).**
- **관리자에게 `point_transactions` select 열기**: `admin-students.md` 결정 D 확정. 담당 학생 아카이브는 "무슨 활동을 했는가"이지 "얼마 벌었는가"가 아니다(원칙 4). **기각.**
- **전환 취소·환급 경로**: 원장 역행 + `points_total` 정합 설계가 필요하고 0005 결정 3-3이 역방향을 상정하지 않는다. **기각**(스펙 결정 G).
- **`point_transactions(student_id)` 인덱스**: 제약의 부산물이 아니라 조회 성능이다. **기각**(결정 5).
- **`notifications` 함께 도입**: 알림 행의 생성자가 `verify_participation_qr()`이 되어 **이미 검증이 끝난 QR 경로를 다시 여는 일**이 된다. **기각**(스펙 결정 I — 별도 스펙).

---

## 영향받는 코드 위치

- `docs/db/schema.sql` — **본 ADR로 갱신 완료.** 5번 절에 select 정책 추가, **8번 절(`reviews`)·9번 절(마이페이지 RPC 2개) 신규**, `profiles` 제약 1개 + 주석 3곳, `point_transaction_type` 주석, 시연 리셋 절차. **backend-agent는 이 파일을 마이그레이션으로 변환한다.**
- `docs/adr/0005-...md` — "향후 변경"의 3개 항목에 본 ADR 참조 표기 **완료**.
- `supabase/migrations/{타임스탬프}_add_mypage_ledger_reviews_and_profile_writes.sql` — **backend-agent** 신규 (이번 마이그레이션 1건이 전부)
- `supabase/migrations/20260723120000_...sql` / `20260730120000_...sql` — **수정하지 않는다.** 적용된 마이그레이션은 고치지 않는다. 뒤집히는 주석(`point_transaction_type`, `profiles.points_balance`, `point_transactions` 테이블)은 **새 마이그레이션에서 `comment on ...`을 다시 실행해 덮어쓴다.**
- `src/lib/pointService.js` (신규) / `src/lib/reviewService.js` (신규) / `src/lib/profileService.js` (신규) — **frontend-agent**
- `src/lib/archiveService.js` (신규, admin-students와 공유) — **frontend-agent**
- `src/pages/StudentArchivePage.jsx` / `StudentMyPage.jsx` — **frontend-agent** 전면 교체
- `src/components/student/ReviewForm.jsx` (신규) / `QrCenterModal.jsx:289` 훅 지점 — **frontend-agent**
- `src/context/AuthContext.jsx` — **frontend-agent** profile 갱신 경로(스펙 이슈 3)
- `scripts/seed-*.mjs` — **변경 없음**

---

## 구현 가이드

### backend-agent가 구현할 부분

**새 마이그레이션 1건** (`supabase/migrations/{타임스탬프}_add_mypage_ledger_reviews_and_profile_writes.sql`). 기존 마이그레이션의 주석 관례를 그대로 따를 것 — `[RLS 권한 경계]` / `[RPC 권한 경계]` / `[권한 경계]` 블록 형식(대상 역할 / 허용 행 / 불가능 / 용도).

**순서대로:**

1. **`profiles` 제약 1개 추가**
   - `alter table public.profiles add constraint profiles_balances_non_negative check (points_balance >= 0 and points_total >= 0 and currency_balance >= 0);`
   - 재적용 안전성을 위해 존재 확인 패턴(`do $$ ... exception when duplicate_object then null $$`) 또는 사전 drop을 쓸 것.
   - `comment on column public.profiles.points_balance` **덮어쓰기** — 결정 3-6의 writer 표를 담을 것. `currency_balance` / `career_interest` 주석도 갱신(전자는 "이 값을 늘리는 유일한 경로 = 전환 RPC, 차감·사용처 없음", 후자는 "쓰기 경로 = `set_career_interest()`").

2. **`point_transactions_select_own` 정책 1개**
   - **insert/update/delete 정책을 만들지 말 것**(0개가 의도).
   - 관리자용 정책을 만들지 말 것.
   - `comment on table public.point_transactions` **덮어쓰기** — "정책 0개" 문장이 뒤집힌다. 새 문장: select 1개(본인 축)만 열렸고 쓰기는 여전히 0개, 관리자는 0행.
   - `comment on type point_transaction_type` **덮어쓰기** — "이번 스코프에서 생성되는 값은 '적립' 하나뿐" 문장이 뒤집힌다.

3. **`public.reviews` 테이블 + 정책 3개 + 컬럼 grant**
   - 컬럼·제약은 결정 2-1 표 그대로. `comment on table/column`을 남길 것.
   - 정책 3개: 결정 2-2. **`p.student_id = auth.uid()` 절을 세 정책 모두에서 빼지 말 것** — 주석에 결정 2-3의 경고(빼면 관리자가 담당 학생 5명의 리뷰를 읽는다)를 그대로 남길 것.
   - insert/update 정책은 `p.status = 'completed'`를 포함, select 정책은 **포함하지 않는다**(상태는 단방향이라 이미 완료분뿐이다 — 주석으로 근거를 남길 것).
   - update는 **using + with check 양쪽** 필요.
   - grant: `revoke insert, update ... from authenticated;` `... from anon;` → `grant insert (participation_id, rating, comment)` / `grant update (rating, comment)`.
   - **delete 정책·delete grant 조작을 하지 말 것.**

4. **`public.convert_points_to_currency(integer)`** — 결정 3-1의 7단계를 그대로.
   - `security definer` + `set search_path = ''` + 모든 객체 `public.`/`auth.` 수식
   - `revoke all on function ... from public;` → `grant execute ... to authenticated;`
   - **금액 검증(3단계)을 절대 빼지 말 것** — 함수 주석에 "음수 인자는 잔액을 늘리는 경로 = 포인트 자가 발행"을 명시할 것(결정 3-4)
   - **UPDATE를 원장 insert보다 먼저** 둘 것(순서가 2차 방어의 조건이다)
   - UPDATE의 `where`에 `points_balance >= p_amount`가 **반드시** 있어야 한다. 빠지면 잔액이 음수가 되고 동시성 방어가 사라진다
   - SET 목록에 `points_total`을 **넣지 말 것**
   - 잔액 부족은 **예외가 아니라 `{ok:false, reason:'insufficient_balance'}` 반환** + 최신 잔액 3종 동봉
   - 원장 insert의 `related_participation_id`는 **명시적 `null`**

5. **`public.set_career_interest(public.career_track)`** — 결정 4-1 그대로.
   - 인자 타입을 `text`로 바꾸지 말 것
   - SET 목록은 `career_interest` 하나뿐
   - `revoke all from public` → `grant execute to authenticated`

6. **시연 리셋 절차 갱신** (`participations` 테이블 comment + `schema.sql` 말미):
   ```
   delete from public.participations;   -- point_transactions + reviews 가 cascade 로 함께 삭제된다
   update public.profiles set points_balance = 0, points_total = 0, currency_balance = 0;
   ```
   **`currency_balance` 초기화가 새로 필요하다** — 빠뜨리면 리셋 후에도 "전환한 지역화폐 ₩N"이 남는다.

7. **만들지 말 것 (하나라도 늘면 설계가 어긋났다는 신호)**
   - `profiles`의 update/insert/delete 정책, `profiles`의 grant/revoke 조작
   - `participations`의 새 정책·트리거·컬럼, `participations_insert_own` drop/create
   - `point_transactions`의 insert/update/delete 정책, 관리자용 select 정책
   - `reviews`의 delete 정책
   - 트리거 (이번 4건에 교차 행 규칙이 없다)
   - `point_transactions` / `reviews`의 조회용 인덱스
   - `verify_participation_qr()` / `issue_participation_qr()` / `participations_capacity_guard()` 수정
   - `point_transactions_source_rule` CHECK 수정
   - 새 시드

8. **적용 후 실제로 뚫어볼 것** (anon 키 + 실제 계정. **`service_role` 금지**)
   - 학생 A: `select * from point_transactions` → **본인 행만**. 학생 B 행 0건
   - 관리자: `select * from point_transactions` → **0행**
   - 학생: `insert into point_transactions {...}` → 403
   - 학생: `update profiles set points_balance = 999999` → 0행
   - 학생: `update profiles set career_interest = 'it'` (직접) → **0행**
   - `rpc('convert_points_to_currency', {p_amount: 잔액+10})` → `{ok:false, reason:'insufficient_balance'}` (**403이 아니어야 한다**)
   - `p_amount: -1000` → **22023.** 이후 `points_balance`가 늘지 않았는지 확인
   - `p_amount: 11` / `50` / `0` / `null` → 전부 22023
   - 정상 전환 1회 → `points_balance` 감소 / `currency_balance` 증가 / **`points_total` 불변** / 원장 `전환` 1행 + `related_participation_id is null`
   - 두 세션에서 **거의 동시에** 전액 전환 → 정확히 1건 성공, `points_balance >= 0`
   - 관리자: `rpc('convert_points_to_currency', {p_amount: 100})` → **403**
   - `rpc('set_career_interest', {p_track: 'it'})` → 성공 → **DB에서 `points_*`/`currency_balance`/`role`/`code`/`name` 불변 확인**
   - `rpc('set_career_interest', {p_track: null})` → 해제(NULL)
   - `rpc('set_career_interest', {p_track: 'med'})` → **22P02/400**
   - 관리자: `rpc('set_career_interest', ...)` → **403**
   - 학생 A: 본인 `completed` 참여에 리뷰 insert → 성공 / 같은 참여 재insert → **23505**
   - 학생 A: 본인 `applied` 참여에 리뷰 insert → **403**
   - 학생 A: 학생 B의 `participation_id`로 insert → **403**
   - 학생 A: `update reviews set participation_id = 다른 참여` → **403**(컬럼 grant), `set rating = 5` → 성공
   - 학생 A: `select * from reviews` → 본인 것만 / **관리자: 0행**
   - `delete from reviews` → 0행/403
   - `rating = 0` / `6`, 61자 comment → 23514
   - **회귀 확인**: 관리자가 `insert into participations {student_id: 본인}` → **여전히 403** (폐루프 차단 생존) / QR 발급 → 입장 → 퇴장 → 포인트 지급이 **그대로 동작** / 정원 1짜리 프로그램 신청 차단이 **그대로 동작**

### frontend-agent가 구현할 부분

**backend 적용 후 착수한다.** 순서는 스펙 "다음 단계 3번"을 따르되(QR 진입점·로그아웃 보존이 최우선), 데이터 계약은 아래가 소스다.

1. **`src/lib/pointService.js` (신규)**
   - `fetchMyPointTransactions()` → `select('id, type, amount, related_participation_id, created_at').order('created_at', {ascending:false}).limit(50)`. **`student_id` 필터를 클라이언트에서 걸지 않는다**(정책이 소유자).
   - `convertToCurrency(amount)` → `supabase.rpc('convert_points_to_currency', { p_amount: amount })`
     - `data.ok === true` → `{points_balance, points_total, currency_balance}`로 **AuthContext의 profile을 즉시 갱신**(스펙 이슈 3). 재조회 왕복이 필요 없다.
     - `data.ok === false && data.reason === 'insufficient_balance'` → **"포인트가 부족합니다. 잔액을 다시 확인해 주세요."** + 응답에 실린 잔액으로 화면 갱신. 모달 유지.
     - `error.code === '22023'` → "전환 금액은 100P 이상, 10P 단위여야 합니다." (정상 UI에서는 발생하지 않는다)
     - `error.code === '42501'` → **"권한 오류 · 다시 로그인해 주세요."** — 잔액 부족과 **절대 섞지 말 것**
     - 네트워크 실패 → 성공 여부가 불확실하므로 **잔액을 반드시 재조회**한다
   - 실행 중 버튼 잠금(멱등이 아니다 — 두 번 호출하면 두 번 차감되는 것이 정상이다).
2. **`src/lib/reviewService.js` (신규)**
   - `fetchMyReviews()` → `select('id, participation_id, rating, comment, created_at')`. `participation_id`를 키로 하는 **Map**을 만든다(건별 조회 금지).
   - `upsertMyReview(participationId, rating, comment)` → insert 시도 후 `23505`면 update로 전환. **사용자에게 에러로 보이지 않게 한다.**
   - **`.update()`는 0행이어도 `error === null`이다.** 반드시 `.select()`로 영향 행을 확인하고, 0행이면 "저장 권한이 없거나 기록이 오래됐습니다. 새로고침해 주세요"로 처리한다.
   - **빈 한줄평은 `null`로 보낸다**(`comment.trim() || null`). 60자 초과를 보내지 않는다(DB CHECK가 23514를 낸다).
   - insert에 `participation_id, rating, comment` **외 어떤 컬럼도 보내지 않는다**(컬럼 grant. `id`/`created_at`을 보내면 403).
   - update에 `participation_id`를 **포함하지 않는다**(같은 이유로 403).
3. **`src/lib/profileService.js` (신규)**
   - `setCareerInterest(track)` → `supabase.rpc('set_career_interest', { p_track: track })`. **해제는 `{ p_track: null }`을 명시적으로 보낸다**(키를 빼면 함수 시그니처 불일치로 실패한다).
   - 반환 `{ok:true, career_interest}`로 **AuthContext를 갱신**한다 — 갱신하지 않으면 `StudentHomePage`의 `[profile]` 의존 `useEffect`가 재실행되지 않아 **홈 추천이 안 바뀐다**(스펙 이슈 3). `window.location.reload()`로 때우지 말 것.
   - 실패 시 칩을 이전 값으로 롤백 + 사유 표시. **조용히 삼키지 말 것.**
4. **`src/lib/archiveService.js` (신규·공유)** — `admin-students.md`와 같은 파일. 학생 id에 의존하지 않는 결합 함수로 짠다.
   - **embed·뷰 금지**(정의자 권한 함정). 병렬 쿼리 + 클라이언트 Map 결합.
   - 아카이브 활동 행의 포인트(확정 L-1)는 **`point_transactions.amount`**를 `related_participation_id`로 결합해 표시한다. **`programs.points`를 쓰지 말 것.**
   - 포인트 내역의 활동명은 `related_participation_id → participations.program_id → programs.title` **2단 결합**이다. 전환 행은 이 축이 NULL이므로 `undefined` 접근으로 죽지 않게 방어한다.
   - 4개 조회(참여·프로그램·리뷰·원장)는 **독립적으로 실패**해야 한다. `Promise.all` 하나로 묶지 말 것(스펙 이슈 4).
5. **`ReviewForm.jsx` (신규, 공용 1개)** — `QrCenterModal.jsx:289` 훅 지점(퇴장 완료 화면)과 아카이브 활동 상세 모달이 **같은 컴포넌트**를 쓴다. 폼을 2개 만들면 검증 규칙이 갈라진다.
   - **입장 완료 화면에는 노출하지 않는다.** 건너뛰기 허용. **QR 발급·폴링·만료 로직에 손대지 않는다.**
6. **[원칙 가드]** PDF에 포인트를 넣지 않는다(확정 L-1) / 평균 별점·리뷰 수·다른 학생 리뷰를 만들지 않는다(애초에 데이터를 얻을 수 없다) / 전환 모달의 시뮬레이션 고지와 "되돌릴 수 없습니다"를 삭제·축약하지 않는다.

**멈추고 보고해야 하는 조건**: QR 관련 파일·함수를 수정해야 한다는 결론 / `service_role`이나 PDF 라이브러리가 필요하다는 결론 / 포인트를 늘리는 클라이언트 코드가 필요하다는 결론.

### qa-agent가 볼 것 (핵심 3가지)

1. **전환이 프런트 우회로도 막히는가** — 특히 **음수 금액으로 잔액이 늘지 않는가**(결정 3-4). `points_balance`가 어떤 경로로도 음수가 되지 않는가.
2. **관리자로 `point_transactions`와 `reviews`가 둘 다 0행인가** — 경계를 넓히지 않았다는 증거.
3. **계열 저장 후 DB에서 `career_interest`만 바뀌었는가** — `points_*`/`currency_balance`/`role`/`code`가 그대로인지 직접 확인.
