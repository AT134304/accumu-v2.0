# ADR 0006: 프로그램 정원 초과 시 신청 차단 (정원 게이트)

## 상태

확정

## 배경

`docs/specs/admin-programs.md`의 확정 F(2026-07-30, 케빈 승인)가 "정원이 차면 학생 신청을 차단한다"를 결정했다. 요구사항 전문은 그 스펙의 **F-1 ~ F-9**이며, 이 ADR은 그것을 DB 경계로 옮기는 작업만 다룬다. 확정 F 자체와 F-2 ~ F-5의 판단(무엇을 세는가 / 숫자를 노출하지 않는다 / 소급 적용하지 않는다 / `status` 파생 없음)은 **재논의하지 않는다.**

이 변경은 프로그램 관리 화면(올리기·내리기·수정)과 **분리해서 진행할 수 있다.** 프로그램 관리 쪽은 ADR 0005 결정 7-0/7-1/7-4가 이미 확정했고 새 설계가 없다(스펙 "다음 단계" 1번). 이 ADR의 범위는 **정원 게이트 하나뿐**이다.

### 이 ADR이 의존하는 ADR 0005의 확정 절 (재논의 대상 아님)

| 절 | 내용 | 이 ADR에서의 역할 |
|---|---|---|
| 결정 2-1 | `participations` **update / delete 정책 0개**(학생·관리자 모두) | 참여 행이 사라지거나 되돌아가지 않는다 → **count가 단조 증가**한다는 F-2의 근거 |
| 결정 2-2 | RLS로 표현할 수 없는 것(컬럼 경계·인자·원자성·사유 구분) | 차단 수단 선택의 판단 기준 |
| 결정 6-1(b) | `participations_insert_own`의 `not public.is_admin()` — 관리자 무한 적립 폐루프 차단 | **건드리지 않는다**(아래 "결정 1-4") |
| 결정 6-2 | 컬럼 단위 `grant insert (student_id, program_id)` | 학생용 insert 경로가 **하나뿐**임을 보장 → F-8-3이 걱정한 "경로 둘" 문제가 애초에 없다 |
| 결정 6-3 | with check의 `p.is_published = true` 서브쿼리 | **건드리지 않는다** |
| 결정 7-2(a) | 정책 재귀와 `security definer` 우회 패턴(`is_admin()`) | 같은 계열의 함정 검토(아래 "결정 3") |
| 결정 7-2(d) | 관리자에게 열린 `participations` = **담당 5명의 `completed`뿐** | **넓히지 않는다.** F-3의 핵심 |
| 결정 7-4 | 관리자의 사후 조작이 이미 신청한 학생의 인증 흐름을 끊지 않는다 | 정원 축소도 같은 답(F-4) |

### 이 ADR이 개정하는 것

- `docs/specs/student-programs.md` **확정 C-1** — 문장 단위 개정. 아래 "결정 9".
- `programs.capacity` **컬럼 주석** — 뒤집힌 문장이 있다. 아래 "결정 9".
- `participations_insert_own`의 `[RLS 권한 경계]` **주석** — "정원은 여기서 막히지 않는다"를 추가. 아래 "결정 9".

**정책 SQL은 한 줄도 개정하지 않는다.** 이번 변경으로 새로 생기는 SQL 객체는 **함수 1개 + 트리거 1개**뿐이다.

---

## 결정 1 — 차단 수단: **`before insert` 트리거 1개** (`security definer`)

### 1-1. 결론

```
public.participations_capacity_guard()   -- returns trigger, security definer, set search_path = ''
  ↳ trigger participations_capacity_guard  before insert on public.participations for each row
```

| 후보 | 판정 | 결정적 사유 |
|---|---|---|
| `participations_insert_own`의 `with check`에 정원 절 추가 | **기각** | (a) 정책 표현식 안에서 `participations`를 세면 정책 재귀(F-8-1). (b) 통과해도 위반이 `42501`이라 미게시 신청·관리자 자기참여·컬럼 위조와 **구분 불가**(F-6). (c) 정책은 잠금을 걸 수단이 없어 F-7(동시성)을 만족할 수 없다. **세 요구를 동시에 어긴다.** |
| 신청 자체를 `security definer` RPC로 이관 | **기각** | 아래 1-3 |
| **`before insert` 트리거** | **채택** | 아래 1-2 |

### 1-2. 채택 근거

**(a) 정원은 "쓰기 로직"이 아니라 "교차 행 제약"이다 — 제약 층에 있어야 한다.**
스펙 F-1이 정원을 놓은 자리가 정확히 이 층이다:

| 규칙 | 표현 수단 |
|---|---|
| 중복 신청 금지 | `unique (student_id, program_id)` (ADR 0004) |
| 미게시 프로그램 신청 금지 | `with check`의 `is_published` 서브쿼리 (결정 6-3) |
| 이중 포인트 지급 금지 | CAS + `unique (related_participation_id)` (결정 3-3) |
| **정원 초과 금지** | **? — Postgres에 교차 행 선언적 제약이 없다** |

`unique`·`check`는 **한 행 안에서** 표현 가능한 것만 막는다. 정원은 "같은 `program_id`를 가진 **다른 행들의 개수**"라서 선언적 제약으로 쓸 수 없고, Postgres에서 교차 행 제약의 표준 구현이 **잠금을 동반한 `before insert` 트리거**다. 없는 기법을 발명하는 게 아니라 이 자리의 정석을 쓰는 것이다.

**(b) F-1(프런트 우회 불가)을 경로와 무관하게 만족한다.**
트리거는 `insert into public.participations`라는 **문장 자체**에 붙는다. PostgREST든 `curl`이든 미래에 생길 어떤 경로든 반드시 통과한다. "판정 소유자가 DB"라는 요구를 가장 강하게 만족하는 형태다.

**(c) F-6(구분 가능한 신호)을 만족한다.** 스펙이 허용한 3가지 형식(`전용 errcode` / 제약 이름 / RPC 반환값) 중 첫 번째다. 상세는 결정 5.

**(d) ADR 0005의 검증된 경계를 한 글자도 건드리지 않는다.** with check 9절 + 컬럼 단위 grant가 **그대로 살아 있는 채로** 정원 절만 옆에 추가된다(F-8-2 완전 충족).

### 1-3. `security definer` RPC(`apply_to_program()`)를 기각한 이유 — 가장 오래 검토한 항목

이 프로젝트가 "**조회는 RLS, 쓰기는 RPC**"(결정 2-1)를 유지해온 것은 사실이고, 그 구조와의 정합성이 RPC 안의 가장 강한 논거다. 그럼에도 기각한다.

**(a) 결정 2가 RPC를 요구한 5가지 사유 중 이번에 해당하는 것은 1개뿐이다.**

| 결정 2-2의 사유 | 정원에 적용되는가 |
|---|---|
| RLS는 컬럼 단위가 아니다 | **아니다.** insert의 컬럼 경계는 결정 6-2의 컬럼 단위 grant가 이미 해결했다 |
| 정책 표현식에 인자를 넘길 수 없다 | **아니다.** 정원 판정에 클라이언트 인자가 필요 없다(`program_id`는 삽입될 행 안에 있다) |
| 남의 `profiles`를 수정해야 한다 | **아니다.** 쓰기 대상은 `participations` 1행뿐 |
| 원자성(3개 쓰기가 한 트랜잭션) | **아니다.** 쓰기가 1개다 |
| 거부 사유 구분 | **그렇다** ← 유일하게 해당 |

즉 결정 2의 진짜 규칙은 "쓰기는 전부 RPC"가 아니라 "**RLS로 표현할 수 없는 쓰기는 RPC**"다. 정원은 RLS *정책*으로 표현할 수 없을 뿐, **DB 쓰기 경계에서는 표현할 수 있다.** 그리고 ADR 0005는 참여 신청 insert를 RPC로 옮기지 **않기로** 명시적으로 선택했다 — 대신 with check 9절 + 컬럼 grant로 굳혔고, 마이그레이션에 "학생이 DB에 쓰는 유일한 직접 경로"라고 못박았다.

**(b) RPC로 옮기면 F-1을 지키기 위해 컬럼 grant를 회수해야 하고, 그 순간 9절이 죽는다.**
RPC를 만들어도 직접 insert 경로가 남아 있으면 그쪽은 정원 검사를 타지 않는다 → **F-1 위반**이고, 정확히 F-8-3이 경고한 "경로가 둘이면 한쪽에만 정원 검사가 붙는 사고"다. 그래서 `grant insert (student_id, program_id)`를 회수해야 하는데, 그러면:

- `participations_insert_own`의 with check 9절이 **도달 불가능한 죽은 정책**이 된다. 살아 있는 것처럼 보이는데 아무것도 막지 않는 정책은 다음 사람을 반드시 속인다.
- 9절 중 최소 3절(`student_id = auth.uid()` / **`not public.is_admin()`** / `is_published = true`)을 **함수 본문에 다시 써야 한다.** 마이그레이션 주석이 "이 두 절 중 하나만 빠져도 관리자 무한 적립이 열린다"고 적어둔 바로 그 절들을, 정원 기능 때문에 두 번째 장소에 옮겨 적는 셈이다.

**(c) 위험의 비대칭.**

| 구현이 틀렸을 때 | 트리거 | RPC + grant 회수 |
|---|---|---|
| 최악의 결과 | 정원이 안 막힌다(기능 열화) | **관리자 무한 적립 폐루프가 다시 열릴 수 있다**(보안 경계 상실) |

정원은 이 데모에서 **부가 기능**이고, `not is_admin()`은 ADR 0005가 "이 마이그레이션 최대의 보안 항목"이라고 부른 절이다. **부가 기능을 위해 최대 보안 항목을 재작성하지 않는다.**

**(d) `security invoker` RPC도 답이 아니다.** 정책 9절을 살린 채(invoker) 함수 안에서 insert하면 경계는 유지되지만, 그 함수는 RLS 때문에 정확한 count를 볼 수 없고(아래 결정 3), 직접 insert 경로도 여전히 열려 있어 F-1을 만족하지 못한다.

> **재검토 시점**: 신청 **취소**(확정 G-1이 미룬 것)나 대기열이 생기면 신청 경로가 "insert 1개"가 아니게 되고 원자성 요구가 생긴다. 그때는 RPC 이관을 다시 검토한다. 지금은 아니다.

### 1-4. 관리자 무한 적립 폐루프(결정 6-1(b)) 영향 — **없음 (확인 완료)**

- `participations_insert_own` 정책을 **drop하지도 재생성하지도 않는다.** `not public.is_admin()`은 그대로다.
- 트리거는 with check보다 **먼저** 실행되므로(아래 결정 5-2), 관리자가 정원이 찬 자기 프로그램에 자기 이름으로 신청하면 `42501` 대신 정원 거부를 먼저 받는다. **어느 쪽이든 거부이고 행은 생기지 않는다** — 폐루프는 여전히 닫혀 있다.
- 트리거는 `participations`의 `insert`에만 붙는다. `programs` insert/update 경로, `verify_participation_qr()`, `issue_participation_qr()`은 **전혀 건드리지 않는다.**

### 1-5. 트리거를 `before insert`**만**으로 한정한다 (놓치면 사고가 나는 지점)

**`before insert or update`로 만들면 안 된다.**

`verify_participation_qr()`은 `participations`를 **update**한다(`status`, `entry_at`/`exit_at`). 트리거가 update에도 걸리면, 관리자가 정원을 줄여 `count > capacity`가 된 프로그램에서 **입장·퇴장 스캔이 통째로 거부된다.** 그건 스펙 F-2가 "정원 기능이 아니라 사고"라고 부른 것 — **현장에 온 학생을 돌려보내는 지점** — 이고, 스펙의 원칙 체크(원칙 5 가드)가 "정원 검사가 QR 검증 경로에 들어가지 않는다"로 명시적으로 금지한 것이다.

→ **정원은 "insert 시점의 게이트"일 뿐이다.** 이 문장을 트리거 주석에 남긴다(F-4의 요구).

---

## 결정 2 — "찼다"의 기준: `status` 무관, 그 프로그램의 참여 행 수

```
정원이 찼다  ⇔  capacity is not null  and  count(*) from participations where program_id = P  >= capacity
```

확정 F-2를 그대로 채택하며, 설계 관점에서 다음을 확인했다.

| 항목 | 결정 | 확인 결과 |
|---|---|---|
| `applied`를 센다 | 확정 F-2 | 신청 = 자리 예약. 빼면 정원이 "입장 시점"에만 의미를 갖고, 입장은 QR 스캔이라 현장 거부 지점이 된다 |
| `entered` / `completed`를 센다 | 확정 F-2 | 전이는 `applied → entered → completed` 단방향(결정 1-4). 어느 상태든 자리 1개 |
| `status`를 조건에 넣지 않는다 | 확정 F-2 | **전이 도중에 count가 흔들리지 않는다.** 상태별 분기를 넣으면 QR 스캔이 정원 판정에 영향을 주게 되어 결정 1-5의 금지선을 우회로 넘는다 |
| count 단조 증가 | **구조적으로 보장됨** | `participations`에 update/delete 정책 0개(결정 2-1). 학생도 관리자도 행을 지우거나 되돌릴 수 없다. 유령 자리가 생길 경로가 없다 |
| 중복이 count를 부풀리지 않음 | **보장됨** | `unique (student_id, program_id)` (ADR 0004) |
| `capacity is null` | **검사 자체를 하지 않는다** | 시드 20건 전부 NULL → **기존 프로그램의 신청 동작에 회귀가 0건**이라는 F-2의 근거가 코드로도 성립한다(트리거가 즉시 `return new`) |
| 자기 자신은 정원에 막히지 않는다 | **추가 결정** | 아래 결정 5-2 |

**[수용] 신청만 하고 안 온 학생이 자리를 막는다.** 취소가 없기 때문이며(확정 G-1 유지), F-2가 이미 수용했다. 취소가 생기면 이 규칙을 재검토한다.

---

## 결정 3 — 정책 재귀는 발생하지 않는다. 그러나 `security definer`는 **다른 이유로** 필수다

F-8-1이 지적한 함정을 검토한 결과, **두 개의 서로 다른 문제**가 있고 채택한 설계는 그중 하나만 만난다.

**(a) 정책 재귀 — 발생하지 않는다.**
재귀는 *정책 표현식*이 자기 테이블을 참조할 때 생긴다(`infinite recursion detected in policy for relation ...`). 이번 설계는 **정책을 하나도 만들지 않는다.** 트리거 본문은 정책 표현식이 아니므로 재귀 판정 대상이 아니다. → `with check` 안에서 세는 안을 기각한 시점에 이 함정은 사라졌다.

**(b) RLS 가시성 — 이것이 진짜 함정이다. 그리고 조용히 실패한다.**
트리거 함수를 `security invoker`(기본값)로 만들면, 함수 안의 `select count(*) from public.participations`는 **호출한 학생의 권한으로 평가된다.** 그 학생에게 열린 정책은 `participations_select_own`(`student_id = auth.uid()`)뿐이므로:

```
count(*) = 0      -- 남의 신청 행이 한 건도 보이지 않는다
0 >= capacity     -- 언제나 거짓
→ 정원이 절대 발동하지 않는다. 에러도, 로그도, 경고도 없다.
```

**fail-open이며 조용하다.** 시연에서 "정원 1인데 3명 다 신청됨"으로만 드러난다.

→ 그래서 함수를 **`security definer`**로 만든다. `is_admin()`이 쓴 것과 **같은 계열의 우회 패턴**이지만 **목적이 다르다**: `is_admin()`은 재귀를 피하려고 definer였고, 이 함수는 **정확한 count를 보려고** definer다. 이 차이를 트리거 주석에 남긴다 — "편의가 아니라 정확성의 조건"이다.

**(c) definer가 여는 표면을 최소화한다.**
이 함수는 **앱에서 유일하게 학생 간 참여 데이터를 가로질러 보는 코드**다. 그래서:

1. **결과를 반환하지 않는다.** 트리거는 클라이언트에게 값을 돌려줄 수 없다 — 구조적으로 count가 밖으로 나갈 수 없다.
2. **`program_is_full(uuid)` 같은 별도 헬퍼 함수를 만들지 않는다.** 만드는 순간 "호출 가능한 표면"이 하나 생기고, 그건 스펙의 **K-2(사전 마감 표시)** 영역이다. K는 아직 확정되지 않았다(현재는 K-1 = 사후 거부). 필요해지면 그때 별도 확정으로 연다.
3. `revoke all on function ... from public;` — 아무에게도 `execute`를 주지 않는다(`qr_generate_token()` 전례, 결정 2-5의 2번). 트리거는 소유자 권한으로 호출되므로 grant가 필요 없다.
4. `set search_path = ''` + 모든 객체 스키마 수식(결정 2-5의 1번).

---

## 결정 4 — 동시성: 정원 검사 전에 **`programs` 행을 `for update`로 잠근다**

### 4-1. 결론

```sql
select p.capacity into v_capacity
  from public.programs p
 where p.id = new.program_id
 for update;          -- <<< F-7 방어의 전부가 이 한 줄이다
```

잠근 뒤에 count한다. 같은 프로그램에 동시 도착한 두 신청은 이 행 잠금에서 **직렬화**되고, 두 번째 트랜잭션은 첫 번째가 커밋된 **뒤에** count를 다시 읽는다(READ COMMITTED는 문장마다 새 스냅샷을 뜬다) → 갱신된 count를 보고 거부된다. 정확히 1건만 성공한다.

### 4-2. 20행 데모에서 여기까지 방어하는 근거

"데모니까 순진한 count로 충분하다"를 검토했고 **기각**했다.

1. **F-7이 인수 조건이다.** "정원 1자리에 두 계정이 동시에 신청 → 정확히 1건만 성공"이 QA 체크리스트에 있다. 순진한 `count(*)`는 READ COMMITTED에서 두 트랜잭션이 같은 값을 읽고 **둘 다 통과**한다.
2. **전례가 이미 있고, 방식도 같다.** 결정 1-4(`select ... for update`로 동시 스캔 직렬화)와 결정 3-3(CAS + unique 2중)이 같은 성질을 이미 확보했다. 여기만 느슨하게 두면 "어디는 막히고 어디는 안 막히는" 상태가 된다.
3. **비용이 거의 0이다.** 잠그는 대상이 `programs` **1행**이고, 트랜잭션은 insert 하나로 끝나 잠금 유지 시간이 마이크로초 단위다. 데모 동시성은 사실상 2다.
4. **잠금 대상 선택이 자연스럽다.** 어차피 `capacity`를 읽으려고 접근하는 행이다. 별도 락 테이블·advisory lock을 도입하지 않는다.

### 4-3. 검토한 대안

- **`pg_advisory_xact_lock(hashtext(program_id::text))`**: `programs` 행을 건드리지 않는 장점이 있으나 해시 충돌(무관한 프로그램끼리 직렬화)과 불투명함이 있고, 잠글 자연스러운 행이 이미 있다. **기각.**
- **`serializable` 격리 수준**: PostgREST 요청마다 격리 수준을 지정하는 경로가 없고, 직렬화 실패 재시도 로직이 클라이언트에 필요해진다. **기각.**
- **잠금 없이 `unique` 제약으로 막기**: "N번째 자리"를 표현하는 컬럼이 없으므로 unique로 정원을 표현할 수 없다(자리 번호 컬럼을 새로 만들어야 하는데 그건 스키마 확장이고 취소가 없는 모델에서 번호 재사용 문제까지 생긴다). **기각.**

### 4-4. 교착(deadlock) 검토

이 트랜잭션이 잡는 잠금은 (1) `programs` 행 `FOR UPDATE`, (2) 삽입되는 `participations` 새 행, (3) FK가 잡는 `programs`/`profiles`의 `FOR KEY SHARE`뿐이다. **모든 세션이 같은 순서(programs → participations)로 잡고**, 같은 트랜잭션 안에서 `FOR UPDATE` 뒤에 오는 FK의 `FOR KEY SHARE`는 이미 더 강한 잠금을 쥔 상태라 대기하지 않는다. 다중 프로그램을 한 트랜잭션에서 신청하는 경로도 없다(insert 1행). → **교착 경로 없음.**

---

## 결정 5 — 거부 신호: **SQLSTATE `P0001` + `hint = 'capacity_full'`** (F-6)

### 5-1. 형식

```sql
raise exception '정원이 모두 찼습니다.'
  using errcode = 'P0001',
        hint    = 'capacity_full';   -- <<< 프런트가 읽는 기계 판별자
```

| 항목 | 값 | 이유 |
|---|---|---|
| SQLSTATE | `P0001` | PostgREST가 **HTTP 400**으로 매핑하는 사용자 예외 코드. `42501`(403)·`23505`(409)와 **HTTP 상태부터 다르다** |
| 기계 판별자 | `hint = 'capacity_full'` | `error.hint`로 그대로 노출된다(supabase-js `PostgrestError`는 `{message, details, hint, code}`). **한국어 메시지를 파싱하지 않는다** |
| 사람이 읽는 메시지 | `'정원이 모두 찼습니다.'` | 콘솔·디버깅용. 화면 문구의 소스는 프런트다 |
| `detail` | **비운다** | 결정 6(정보 노출) |

**`P0001` 단독이 아니라 `hint`를 함께 보는 이유**: `P0001`은 `raise exception`의 기본 코드라 앞으로 다른 도메인 예외가 생기면 충돌한다. 판별은 `hint === 'capacity_full'`로 하고 `code`는 보조로 본다. → 프런트 규율: **`error.hint`로 판별한다.**

전용 SQLSTATE(`PT409` 등 PostgREST 확장 표기)도 검토했으나, 프레임워크 특수 표기에 의존하지 않는 쪽을 택했다.

### 5-2. **[함정] 트리거는 with check·unique보다 먼저 실행된다 — 사유가 뒤바뀔 수 있다**

Postgres의 insert 처리 순서:

```
1. 컬럼 단위 insert grant 검사        → 위반 시 42501/403   (실행 전)
2. BEFORE INSERT 트리거               → 정원 거부 P0001/400  ★ 여기
3. RLS with check 9절                 → 위반 시 42501/403
4. unique (student_id, program_id)    → 위반 시 23505/409
5. FK (program_id, student_id)        → 위반 시 23503
```

즉 **트리거가 중복 신청보다 먼저 판정한다.** 그대로 두면 이런 일이 생긴다:

> 정원 1인 프로그램에 학생 A가 신청해 자리를 채웠다. A가 다른 탭/오래된 화면에서 다시 "신청하기"를 누른다. → count(1) >= capacity(1) → **"정원이 모두 찼습니다"** + 카드가 마감 상태로 바뀐다. **정작 A는 이미 신청돼 있다.**

`'duplicate'`는 프런트에서 에러가 아니라 **"이미 신청됨"으로 화면을 맞추는 상태 동기화 신호**인데(ADR 0004/스펙 에러 표), 그게 마감 표시로 뒤바뀐다.

**→ 해결: 이미 그 프로그램에 행을 가진 학생은 정원 검사를 건너뛴다.**

```sql
if exists (select 1 from public.participations
            where program_id = new.program_id
              and student_id = new.student_id) then
  return new;      -- 뒤이어 unique 제약이 23505 로 막는다 = 'duplicate' 사유가 보존된다
end if;
```

이 절은 **도메인적으로도 옳다**: 이미 자리를 가진 사람은 정원에 막히는 대상이 아니다. F-4("정원을 줄여도 이미 신청한 학생을 쫓아내지 않는다")를 insert 층에서도 성립시킨다.

### 5-3. 순서가 뒤바뀌어도 **수용하는** 조합

| 상황 | 나오는 사유 | 판단 |
|---|---|---|
| 미게시 프로그램인데 정원도 참 | `full`(42501이 아니라) | **수용.** 어느 쪽이든 거부이고 행은 생기지 않는다 |
| 관리자가 자기 프로그램(정원 참)에 자기 이름으로 신청 | `full`(42501이 아니라) | **수용.** 폐루프는 여전히 닫혀 있다(결정 1-4) |
| 이미 신청한 학생의 재신청 | `duplicate` | **결정 5-2로 보존한다.** 수용 대상이 아니라 고쳐야 하는 것이었다 |

### 5-4. 신청 경로의 거부 사유 전체 목록 (이번 변경 후 확정판)

| 사유 | 신호 | HTTP | `applyToProgram` 반환 | 화면 |
|---|---|---|---|---|
| 정원 마감 | `code='P0001'`, **`hint='capacity_full'`** | 400 | **`'full'`** ← 신규 | "정원이 모두 찼습니다" + 버튼 마감 전환 |
| 중복 신청 | `23505` | 409 | `'duplicate'` | 에러 아님. "이미 신청됨"으로 상태 동기화 |
| RLS 거부(미게시·관리자 자기참여·컬럼 위조·남의 이름) | `42501` | 403 | throw | **"권한 오류"**(정상 사용에서는 발생하지 않는다 = 버그 신호) |
| 없는 `program_id` | `23503` | 409 | throw | 기술 오류 |
| 네트워크/타임아웃 | — | — | throw | "잠시 후 다시 시도" |

---

## 결정 6 — 정보 노출: 밖으로 나가는 것은 **"찼다"라는 1비트뿐**

### 6-1. 담는 것 / 담지 않는 것

| | 내용 |
|---|---|
| **담는 것** | 거부됐다는 사실 + 사유 판별자 `capacity_full` + 고정 한국어 메시지 |
| **담지 않는 것** | **현재 신청자 수**, 남은 자리 수, 신청자 명단·이름·학번, `capacity` 값 자체(메시지에 숫자를 쓰지 않는다), 프로그램 제목, `detail` 필드 일체 |

트리거는 **반환값이 없다.** count는 함수 지역 변수(`v_taken`)에만 존재하고 어떤 경로로도 클라이언트에 도달하지 않는다. "서버는 count를 알지만 그 값을 응답으로 내보내지 않는다"(F-3)가 구조적으로 성립한다.

### 6-2. 새로 열리는 조회 표면: **0개**

- 새 RLS 정책 **0개**. 새 select 권한 **0개**. 새 뷰 **0개**. **호출 가능한 새 함수 0개**(트리거 함수는 `revoke all from public`).
- 관리자에게 열린 `participations`는 **여전히 담당 5명의 `completed`뿐**(결정 7-2(d) 불변). 관리자는 정원 차단이 생긴 뒤에도 신청자 수를 셀 수 없다.
- 학생에게 열린 `participations`는 **여전히 본인 행뿐**. `select count(*) from participations where program_id = ?`를 쏘면 **본인 행만 세진다.**

### 6-3. 그럼에도 학생이 추론할 수 있는 것 (명시하고 수용)

학생은 신청을 시도해 **"지금 이 프로그램이 찼는가"라는 1비트**를 얻는다. `capacity`는 `programs` 행에 있어 이미 읽을 수 있으므로(F-8-5: RLS는 컬럼 단위가 아니다 — **정원 상한은 비밀이 아니다**), "찼다"에서 `count >= capacity`를, "안 찼다"에서 `count <= capacity - 1`을 추론할 수 있다.

- **정확한 count는 여전히 얻을 수 없다.** 다른 학생 대신 행을 만들 수 없으므로 경계값을 스스로 만들 수 없다.
- 이 1비트는 **정원 기능이 존재하는 한 어떤 구현에서도 불가피하다**(거부하려면 거부를 알려야 한다). 스펙 K-1이 이미 이 형태를 채택했다.
- **관리자 쪽 오라클은 만들지 않는다**: 정원을 줄이는 update를 막지 않으므로(F-3), "18은 되는데 17은 안 되네 → 정확히 17명" 경로가 생기지 않는다.

### 6-4. 원칙 1 가드 (프런트 필수)

거부 응답에 숫자가 없으므로 화면에도 숫자를 만들 수 없다. **"남은 자리 N석" / "N/20명" / "마감 임박"을 만들지 않는다.** 문구는 정확히 "정원이 모두 찼습니다" 한 줄이다.

---

## 결정 7 — 관리자의 정원 축소: 막지 않는다 / 소급하지 않는다 (F-3·F-4 성립 확인)

설계 관점의 확인만 한다. 결론은 확정 F-3/F-4 그대로다.

| 항목 | 확인 결과 |
|---|---|
| 정원을 줄이는 `update programs` | **막지 않는다.** `programs`에 새 트리거·새 제약을 걸지 않는다. 막으면 응답이 신청자 수 오라클이 된다(F-3) |
| 이미 신청한 학생의 행 | **남는다.** 정원 검사는 `before insert`에만 있다(결정 1-5). 기존 행을 건드리는 코드가 존재하지 않는다 |
| 그 학생의 QR 발급 | **된다.** `issue_participation_qr()`은 `programs`를 읽지 않는다 |
| 그 학생의 입·퇴장 인증 + 포인트 | **된다.** `verify_participation_qr()`은 update이므로 트리거가 걸리지 않고, `capacity`를 판정에 쓰지도 않는다 |
| 초과 신청 학생을 쫓아내기 | **경로가 없다.** `participations`에 update/delete 정책 0개(결정 2-1). 이건 누락이 아니라 설계다 |
| `count > capacity` 상태 | **정합성 위반이 아니라 "정원 초과 상태"로 수용한다**(F-4) |
| `programs.status` 자동 전환 | **없다.** 트리거는 `programs`에 쓰지 않는다(F-5). `status`는 관리자가 손으로 정하는 값 그대로 |

→ **구조적으로 성립한다.** 정원 축소는 결정 7-4(게시중단)와 완전히 같은 계열의 사후 조작이고, 같은 답을 낸다: **관리자의 사후 조작은 이미 신청한 학생의 인증 흐름을 끊지 않는다.**

---

## 결정 8 — 새 인덱스를 추가하지 않는다

정원 검사는 `count(*) from participations where program_id = ?`를 수행하므로 `program_id` 인덱스를 부르고 싶어진다. **추가하지 않는다.**

- ADR 0003 주의 4 / ADR 0004 주의 5의 원칙 유지. 특히 ADR 0004는 **"`program_id` 단독 인덱스를 추가하지 말 것"**을 이름까지 지목해 금지했다.
- 그 원칙의 예외는 ADR 0005 결정 1-5가 정의한 **"제약의 부산물인 인덱스"**뿐이다(`unique (student_id, program_id)`, 토큰 unique 2개). 이번에 필요한 것은 제약이 아니라 **조회 성능**이므로 예외에 해당하지 않는다.
- 실제 규모: `participations`는 데모 전체에서 수십 행이다. 잠금을 이미 쥔 상태의 순차 스캔은 마이크로초다. 인덱스가 이득을 주기 시작하는 규모(수천 행 이상)는 이 프로젝트의 스코프가 아니다(1인 시연용 프로토타입, CLAUDE.md 1장).
- **재검토 조건**: `participations`가 수천 행을 넘거나, 정원 검사가 신청 외 경로에서도 호출되기 시작할 때.

---

## 결정 9 — 확정 C-1 개정 및 주석 갱신 (F-9, 문장 단위)

### 9-1. `docs/specs/student-programs.md` 확정 C-1 개정

**개정 1 — 한 세트로 묶여 있던 두 항목을 분리하고 각각 상태를 부여한다.**

| 항목 | 개정 후 상태 |
|---|---|
| 정원 차단 | **도입한다** (2026-07-30 확정 F / 본 ADR 0006) |
| `status` 파생 전환 | **여전히 하지 않는다** (C-1 유지. F-5) |

**개정 2 — 전제 문장 교체.**

- 삭제: "시드 20건 전부 `capacity`가 NULL이라 정원 개념이 데모에 없고"
- 대체: **"시드 20건은 여전히 전부 `capacity`가 NULL이므로 기존 프로그램의 신청 동작은 바뀌지 않는다. 정원은 관리자 프로그램 관리 화면에서 입력한 프로그램에만 적용된다."**

**개정 3 — "신청 가능 여부의 단일 소스" 문장 교체.**

- 삭제: "신청 가능 여부의 단일 소스는 정적 `status`(`STATUS[].join`)다"
- 대체: **"신청 가능 여부는 두 층이다. (1) 화면 표시·버튼 활성 = 정적 `status`(`STATUS[].join`) + 날짜(확정 H-1). (2) 실제 거부 판정 = DB(중복·미게시·관리자 자기참여·정원). 표시는 프런트가, 경계는 DB가 소유한다."**

> 위 3개는 `docs/specs/student-programs.md`의 확정 C-1 요약 줄에 반영 완료(본 ADR 참조 표기 포함). "열린 질문 원문"의 C-1 블록은 결정 근거 기록이므로 **손대지 않는다**(원문 보존).

### 9-2. `programs.capacity` 컬럼 주석 개정 (마이그레이션 `20260723120000_...sql` 718~721줄 / `docs/db/schema.sql`)

- **뒤집히는 문장(삭제)**: "[ADR 0005] 관리자 프로그램 관리가 열려도 **정원 차단을 구현하지 않는다** — 시드 20건 전부 capacity가 NULL이라 정원 개념이 데모에 존재하지 않는다(확정 C-1 유지)."
- **새 주석에 반드시 담을 6가지**:
  (a) `NULL` = 정원 미정/무제한 — 검사 자체를 하지 않는다 (유지)
  (b) **정원 차단을 구현한다** — `participations`의 `before insert` 트리거 `participations_capacity_guard` (ADR 0006 / 확정 F)
  (c) "찼다"의 기준 = **`status` 무관** 그 프로그램의 참여 행 수 (F-2)
  (d) **기존 행에 소급 적용되지 않는다** — insert 시점의 게이트일 뿐. 정원을 줄여도 신청·QR·포인트가 그대로 동작한다 (F-4)
  (e) **`status` 파생에는 여전히 사용하지 않는다** (F-5)
  (f) **신청자 수를 관리자/학생 화면에 노출하지 않는다** — 서버만 알고 응답에 담지 않는다 (F-3)
- 함께: `program_status` 타입 주석의 "시드 20건 전부 capacity NULL" 문구는 `status`가 파생값이 아니라는 근거로 여전히 유효하다. **정원 차단 도입 후에도 `status`는 수동 지정**이라는 점만 덧붙인다.

### 9-3. `participations_insert_own`의 `[RLS 권한 경계]` 주석 개정 (F-9 개정 5)

지금 주석은 거부 사유를 **7개 + unique**로 열거한다. 여기 없는 거부 사유가 생겼으므로 반드시 추가한다. 정책 SQL은 **한 줄도 바꾸지 않는다** — 주석만 추가한다.

> ```
> --     + 정원 초과 (capacity)             -> 이 정책이 막지 않는다. before insert 트리거
> --                                          participations_capacity_guard 가 막는다 (ADR 0006).
> --                                          위반 시 P0001 / hint='capacity_full' / HTTP 400.
> --       [왜 정책이 아닌가] (1) 정책 표현식에서 participations 를 세면 정책 재귀,
> --                          (2) 위반이 42501 로 나와 위 1~7번과 구분되지 않는다(F-6),
> --                          (3) 정책은 잠금을 걸 수 없어 동시 신청을 막지 못한다(F-7).
> --       [실행 순서 주의] 트리거는 이 with check 보다 먼저 실행된다. 따라서 정원이 찬
> --                        미게시 프로그램에 신청하면 42501 이 아니라 정원 거부가 먼저 나온다(수용).
> ```

---

## 스키마 변경 요약

| 대상 | 변경 |
|---|---|
| 테이블 | **없음.** 새 테이블·새 컬럼 0개 |
| 제약 | **없음** (`programs_capacity_positive`는 이미 있다) |
| 인덱스 | **없음** (결정 8) |
| RLS 정책 | **신규 0개 / 개정 0개.** `participations_insert_own`은 SQL 불변, 주석만 추가 |
| 함수 | **신규 1개** — `public.participations_capacity_guard()` (`returns trigger`, `security definer`, `set search_path = ''`, `revoke all from public`) |
| 트리거 | **신규 1개** — `participations_capacity_guard` `before insert on public.participations for each row` |
| grant / revoke | **없음** (컬럼 단위 insert grant 그대로) |
| 시드 | **없음.** 시드 20건의 `capacity`를 채우지 않는다(F-2 회귀 없음의 근거) |
| 주석 | `programs.capacity` 개정 + `participations_insert_own` 주석 추가 + 트리거/함수 주석 신규 |

**함수 시그니처 · 반환 형태 (backend가 그대로 구현할 것)**

```
public.participations_capacity_guard() returns trigger
  language plpgsql | volatile | security definer | set search_path = ''
  반환: new (통과) — 트리거 함수이므로 클라이언트로 나가는 반환값이 없다
  예외: errcode 'P0001', message '정원이 모두 찼습니다.', hint 'capacity_full', detail 없음
  실행 순서(본문):
    1) select capacity from public.programs where id = new.program_id for update   ← 잠금
    2) if not found        -> return new     (없는 program_id 는 FK 23503 이 담당)
    3) if capacity is null -> return new     (무제한. 시드 20건이 전부 여기로 빠진다)
    4) if exists(같은 student_id + program_id 행) -> return new   (unique 23505 = duplicate 보존, 결정 5-2)
    5) select count(*) from public.participations where program_id = new.program_id   ← status 조건 없음
    6) if count >= capacity -> raise (위 예외)
    7) return new
  grant: 없음 (revoke all from public. 트리거가 소유자 권한으로 호출한다)
```

---

## RLS/권한 영향

### 이번에 열리는 것

**없다.** 새 정책 0개, 새 select 권한 0개, 호출 가능한 새 함수 0개.

### 이번에도 닫힌 채로 유지되는 것 (확인 완료)

| 항목 | 상태 |
|---|---|
| `participations` update/delete 정책 | **0개 유지**(결정 2-1). F-4가 여기에 기댄다 |
| `participations_insert_own` with check 9절 | **9절 전부 유지.** SQL 불변 |
| `not public.is_admin()` (관리자 무한 적립 폐루프 차단) | **유지.** 이번 변경이 건드리지 않는다(결정 1-4) |
| `p.is_published = true` (미게시 신청 차단) | **유지** |
| 컬럼 단위 `grant insert (student_id, program_id)` | **유지.** 회수하지 않는다 |
| 관리자의 `participations` 조회 | **담당 5명의 `completed`뿐**(결정 7-2(d)). 넓히지 않았다 |
| 학생의 `participations` 조회 | **본인 행뿐.** 남의 신청 수를 셀 수 없다 |
| `programs` 정책 3개 | **불변.** 새 정책을 만들면 설계가 어긋났다는 신호다 |

### 공격/오작동 경로 대조표 (이번 항목만)

| 경로 | 차단 장치 | 결과 |
|---|---|---|
| 프런트 버튼을 우회해 정원 찬 프로그램에 직접 insert | `before insert` 트리거 | `P0001` / `capacity_full` / 400 |
| `curl` + anon 키로 REST insert | 같은 트리거(문장에 붙어 있다) | 동일 |
| 정원 마지막 1자리에 동시 신청 2건 | `programs` 행 `for update` + 잠금 후 재count | 정확히 1건 성공 |
| 학생이 신청자 수 조회 시도 | `participations_select_own` | 본인 행만 |
| 관리자가 신청자 수 조회 시도 | 결정 7-2(d) | 담당 5명 `completed`만 |
| 정원 거부 응답에서 count 역산 | 응답에 숫자 없음(결정 6-1) | 1비트만 노출(수용) |
| 관리자가 정원을 줄여 기존 학생 축출 | insert 게이트 + update/delete 정책 0개 | 경로 자체가 없음 |
| 정원 초과 상태에서 QR 입·퇴장 | 트리거가 `before insert`**만**(결정 1-5) | 정상 동작 |
| 관리자가 정원 찬 자기 프로그램에 자기 신청 | 트리거 → 거부(그 뒤 `not is_admin()`도 있음) | 행 생성 불가(2중) |
| `security invoker`로 만들어 count가 0이 되는 사고 | `security definer` 필수(결정 3-b) | 설계로 차단 |

---

## 대안으로 고려했던 것

- **`participations_insert_own`의 `with check`에 정원 절 추가**: 정책 재귀(F-8-1) + `42501`이라 사유 구분 불가(F-6) + 잠금 불가(F-7). 세 요구를 동시에 어긴다. **기각**(결정 1-1).
- **`with check` + `security definer` 카운트 헬퍼**(재귀만 우회): 재귀는 풀리지만 `42501` 문제와 잠금 문제가 그대로다. 게다가 호출 가능한 "찼는가" 함수가 생겨 K-2 표면이 열린다. **기각.**
- **신청을 `security definer` RPC(`apply_to_program`)로 이관**: 구조 정합성("쓰기는 RPC")이 가장 강한 논거였으나, F-1을 지키려면 컬럼 grant를 회수해야 하고 그 순간 with check 9절이 죽으며 `not is_admin()`을 함수 본문에 재작성하게 된다. 부가 기능을 위해 최대 보안 항목을 다시 쓰는 위험 비대칭. **기각**(결정 1-3). 신청 취소/대기열이 생기면 재검토.
- **`security invoker` RPC + 정원 검사**: 9절은 살지만 RLS 때문에 count가 0이 되고, 직접 insert 경로도 남아 F-1 미충족. **기각.**
- **트리거를 `before insert or update`로**: `verify_participation_qr()`의 상태 전이가 정원 초과 프로그램에서 거부되어 **현장에 온 학생을 돌려보낸다**. 스펙이 원칙 5 가드로 명시 금지. **기각**(결정 1-5).
- **트리거를 `security invoker`로**: count가 본인 행만 보여 **정원이 조용히 무력화**된다(fail-open). **기각**(결정 3-b).
- **`program_is_full(uuid)` 공개 함수로 분리**: 재사용성은 있으나 호출 가능한 표면이 하나 늘고, 그것이 곧 K-2(사전 마감 표시)다. K는 미확정. **기각**(결정 3-c).
- **`programs`에 `applied_count` 비정규화 컬럼 + 트리거 증감**: 잠금이 자연스러워지지만 (1) 없는 컬럼을 지어내는 것이고(CLAUDE.md 5장·스펙에 없다), (2) **관리자가 `programs`의 모든 컬럼을 수정할 수 있어**(결정 7-1) 신청자 수를 관리자가 위조·조회할 수 있게 된다 = F-3 위반. **기각.**
- **`pg_advisory_xact_lock`으로 직렬화**: 해시 충돌로 무관한 프로그램끼리 직렬화되고 불투명하다. 잠글 자연스러운 행이 이미 있다. **기각**(결정 4-3).
- **잠금 없이 count만 검사**(데모 규모니까): READ COMMITTED에서 동시 2건이 둘 다 통과한다. F-7이 인수 조건이고 결정 1-4/3-3의 전례와 어긋난다. **기각.**
- **`status`별 가중치 count**(`applied`는 0.5자리 등): 규칙이 복잡해지고 전이 도중 count가 흔들린다. F-2가 이미 `status` 무관으로 확정. **기각.**
- **`program_id` 인덱스 추가**: ADR 0004 주의 5가 이름까지 지목해 금지했고, 제약의 부산물 예외에 해당하지 않는다. 데모 규모에서 이득 없음. **기각**(결정 8).
- **정원 초과 시 `programs.status`를 `full`로 자동 전환**: 관리자가 손으로 정한 값을 서버가 덮어써 소유권이 모호해진다. **기각**(F-5 유지).
- **거부 메시지에 "정원 N명"을 포함**: 상한 자체는 비밀이 아니지만(F-8-5), 메시지에 숫자를 넣기 시작하면 다음 사람이 count를 넣는다. 문구를 숫자 없이 고정한다. **기각.**
- **시드 20건 중 일부에 `capacity`를 채워 시연 준비**: F-2의 "기존 동작 회귀 없음" 근거가 사라지고, 학생 화면 회귀 테스트의 기준선이 흔들린다. 시연은 관리자 화면에서 정원 1짜리를 직접 만들어 보여준다. **기각.**

---

## 영향받는 코드 위치

- `docs/db/schema.sql` — **본 ADR로 갱신 완료.** 4-1절(정원 게이트 함수 + 트리거) 신규, `programs.capacity` 주석 개정, `participations_insert_own` 주석 추가. **backend-agent는 이 파일을 마이그레이션으로 변환한다.**
- `docs/specs/student-programs.md` — 확정 C-1 요약 줄 **개정 완료**(결정 9-1).
- `supabase/migrations/{타임스탬프}_add_program_capacity_gate.sql` — **backend-agent** 신규 (이번 마이그레이션 1건이 전부)
- `supabase/migrations/20260723120000_add_qr_auth_and_admin_boundaries.sql` — **수정하지 않는다.** 적용된 마이그레이션은 고치지 않는다. 뒤집힌 주석(`capacity`)은 **새 마이그레이션에서 `comment on column`을 다시 실행해 덮어쓴다.**
- `src/lib/programService.js` — **frontend-agent**: `applyToProgram` 반환값에 `'full'` 추가
- 학생 참여 팝업/카드 (`StudentProgramsPage` 계열) — **frontend-agent**: 정원 거부 문구 + 버튼 마감 전환
- `scripts/seed-programs.mjs` — **변경 없음**(시드의 `capacity`를 채우지 않는다)

---

## 구현 가이드

### backend-agent가 구현할 부분

**새 마이그레이션 1건** (`supabase/migrations/{타임스탬프}_add_program_capacity_gate.sql`). 기존 마이그레이션의 주석 관례를 따를 것(`[RLS 권한 경계]` / `[권한 경계]` 블록 형식).

1. **`public.participations_capacity_guard()` 생성** — 위 "함수 시그니처 · 반환 형태"의 7단계를 그대로. 빠뜨리면 안 되는 것:
   - `security definer` + `set search_path = ''` + 모든 객체를 `public.`으로 수식 (결정 2-5의 1·3번)
   - `revoke all on function public.participations_capacity_guard() from public;` — **아무에게도 `grant execute`하지 않는다**(`qr_generate_token()` 전례)
   - `for update`를 **빠뜨리지 말 것**. 이 한 줄이 F-7 방어의 전부다 (결정 4)
   - 4단계(같은 학생의 기존 행이면 통과)를 **빠뜨리지 말 것**. 없으면 중복 신청이 `duplicate`가 아니라 `full`로 나간다 (결정 5-2)
   - `raise exception ... using errcode = 'P0001', hint = 'capacity_full'` — **`hint` 문자열이 프런트 계약이다.** 오타 금지, 번역 금지
   - 메시지·`detail`에 **숫자를 넣지 말 것** (결정 6)
2. **트리거 생성** — `before insert on public.participations for each row`. **`or update`를 붙이지 말 것**(결정 1-5 — QR 인증이 막힌다).
   - 재적용 안전성: `drop trigger if exists ... on public.participations;` 후 `create trigger` (또는 PG15의 `create or replace trigger`).
3. **주석 3종**
   - `comment on function public.participations_capacity_guard()` — definer인 이유가 "재귀 회피"가 아니라 **"invoker면 count가 본인 행만 보여 정원이 조용히 무력화된다"**임을 남길 것 (결정 3-b)
   - `comment on column public.programs.capacity` — 결정 9-2의 (a)~(f) 6가지를 전부 담아 **덮어쓴다**
   - `participations_insert_own` 블록 위 주석에 결정 9-3의 블록 추가. **정책 SQL은 `drop`/`create`하지 않는다** — 주석만 추가한다(정책을 다시 만들면 9절을 옮겨 적다가 한 절을 잃을 위험이 있다)
4. **만들지 말 것 (만들면 설계가 어긋났다는 신호)**
   - `programs` 관련 새 정책 (이미 3개 있다)
   - `participations` 관련 새 정책 / `with check` 개정 / grant·revoke 변경
   - `program_is_full()` 같은 **호출 가능한** 함수 (K-2 표면)
   - `program_id` 인덱스 (결정 8)
   - 시드 `capacity` 채우기
5. **적용 후 실제로 뚫어볼 것** (anon 키 + 실제 계정. **service_role 금지**)
   - 정원 1짜리 프로그램 생성(관리자) → 학생 A 신청 성공 → **학생 B 신청 → `P0001` / `hint='capacity_full'` / HTTP 400**
   - 학생 B가 `curl`/개발자도구로 `insert into participations` 직접 전송 → **똑같이 거부**
   - **학생 A가 같은 프로그램에 재신청 → `23505`(duplicate)여야 한다. `capacity_full`이 나오면 4단계를 빠뜨린 것이다**
   - 두 계정으로 거의 동시에 신청(정원 1) → **정확히 1건 성공**, `select count(*)`가 `capacity`를 넘지 않는다
   - `capacity is null`인 시드 프로그램 신청 → **이전과 완전히 동일하게 성공**(회귀 확인)
   - 학생 A/B 신청 후 관리자가 **정원을 1로 축소** → update 성공(막히지 않는다) → **두 학생 모두 QR 발급 → 입장 → 퇴장 → 포인트 지급이 정상 동작**
   - 정원이 차도 `programs.status`가 그대로다
   - **관리자: `insert into participations {student_id: 본인}` → 여전히 403** (결정 6-1(b) 폐루프 차단이 살아 있는지)
   - 관리자: `select * from participations` → **여전히 담당 5명의 `completed`만**
   - 학생: `select count(*) from participations where program_id = ?` → **본인 행만**

### frontend-agent가 구현할 부분

**정원 차단이 backend에서 끝난 뒤에 착수한다.** 프로그램 관리 화면(등록/수정/토글)은 이것과 무관하게 병행 가능하다.

1. **`src/lib/programService.js`의 `applyToProgram` 확장** — 반환 타입이 `'created' | 'duplicate'` → **`'created' | 'duplicate' | 'full'`**.
   ```
   if (!error) return 'created';
   if (error.hint === 'capacity_full') return 'full';   // ← code('P0001')가 아니라 hint 로 판별
   if (error.code === '23505')        return 'duplicate';
   throw error;                                          // 42501 등은 "권한 오류"
   ```
   - **`42501`을 `'full'`로 뭉개지 말 것.** 권한 오류는 정상 사용에서 발생하지 않는다 = 발생하면 버그 신호다(ADR 0005 결정 4).
   - 응답에 숫자가 없으므로 **숫자를 화면에 만들 수 없다.** 파생 계산도 하지 말 것.
2. **참여 팝업/카드 처리**
   - `'full'` → 문구 **"정원이 모두 찼습니다"**(권한 오류 문구와 명확히 다르게) + 그 카드/팝업 버튼을 **즉시 마감 상태로 로컬 갱신**(같은 세션에서 반복 시도하지 않게 — F-3 완화 1).
   - `'duplicate'` → 기존대로 "이미 신청됨" 상태 동기화. **마감으로 표시하지 말 것.**
3. **[원칙 1 가드 — 필수]**
   - **"남은 자리 N석" / "N/20명" / "마감 임박" / 진행 게이지를 어디에도 만들지 않는다.** 데이터도 없고 원칙도 금지한다(F-3, 스펙 원칙 체크).
   - 사전 마감 표시는 **하지 않는다**(현재 확정은 K-1 = 사후 거부). 사전 표시가 필요하면 K를 먼저 확정해야 한다.
   - 관리자가 `status`를 `full`로 지정하면 사전 표시가 되는 기존 경로는 그대로 쓴다(확정 E) — 그건 수동 운영이지 정원의 파생이 아니다.
4. **관리자 프로그램 관리 폼의 정원 안내**(확정 F / 이미 스펙에 있음) — 값·모드와 무관하게 **항상 표시**:
   > 비워두면 정원 제한이 없습니다. 정원을 채우면 새 신청이 막힙니다. **정원을 줄여도 이미 신청한 학생은 취소되지 않습니다.**
   조건부 문구("현재 N명 신청")는 **만들 수 없다** — 데이터가 없다.

### qa-agent가 볼 것 (핵심 3가지)

1. **프런트를 우회한 직접 insert도 거부되는가** (F-1 — 판정 소유자가 DB인지)
2. **정원 거부와 권한 오류가 화면에서 다른 문구인가**, 그리고 **이미 신청한 학생의 재신청이 `duplicate`로 오는가** (F-6 / 결정 5-2)
3. **정원 축소 후에도 QR 발급 → 입장 → 퇴장 → 포인트가 도는가** (F-4 / 결정 1-5)
