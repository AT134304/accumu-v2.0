# ADR 0005: QR 이중 인증 상태 기계, 포인트 지급 경로, 관리자 쓰기 권한 경계

## 상태
확정 (일부 항목 "케빈 확인 필요" 표시 — 블로킹 아님)

## 배경

`docs/specs/qr-dual-auth.md`의 확정된 결정(2026-07-23, 케빈 승인: **A-1 / B-1 / C-1 / D-1 / E-1 / F-1 / G-3 / H-1**)을 전제로 한다. 이 ADR은 그 결정을 SQL과 권한 경계로 옮기는 작업만 다루며, 결정 자체를 재논의하지 않는다.

**이번 변경은 이 프로젝트에서 권한 표면이 가장 크게 열리는 지점이다.** 지금까지의 상태는 이랬다:

| 테이블 | select | insert | update | delete |
|---|---|---|---|---|
| `profiles` | 본인 1개 | 0 | **0** | 0 |
| `mentor_students` | **0** | 0 | 0 | 0 |
| `programs` | 게시분 1개 | 0 | **0** | 0 |
| `participations` | 본인 1개 | 본인 1개 | **0** | 0 |

즉 **`update` 정책이 전 테이블에 0개**였고, **관리자 전용 정책이 하나도 없었으며**, **포인트를 늘리는 코드가 존재하지 않았다.** 이번에 세 가지가 동시에 열린다 — 최초의 `update` 경로, 최초의 관리자 쓰기, 최초의 포인트 지급. 여기에 확정 G-3(관리자 기능 3종 전부)이 더해지면서 **"남의 `profiles`를 볼 수 있는 최초의 경로"**까지 함께 열린다.

ADR 0004는 이 시점을 정확히 예고하며 결정 목록을 남겨두었다. 특히 이 경고가 이 ADR의 출발점이다:

> RLS는 컬럼 단위가 아니다. `for update using (관리자 조건)` 같은 정책을 순진하게 열면 관리자가 그 행의 모든 컬럼을 바꿀 수 있다(`student_id`를 다른 학생으로 옮기는 것 포함). 그래서 QR 스캔은 정책보다 `security definer` RPC가 유력하다.

전체 SQL은 `docs/db/schema.sql`(갱신 완료). 아래는 결정과 근거다.

---

## 결정 1 — 토큰 메커니즘

### 1-1. 형식: Crockford Base32 10자 (`text` 유지)

ADR 0004가 `text`로 두고 형식을 이 스펙에 미뤄둔 것을 확정한다.

- 알파벳: `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — 0-9 A-Z에서 **I, L, O, U 제외**한 32문자. 스펙 이슈 3의 "혼동 문자 제외"를 표준 규약으로 만족한다.
- 길이 **10자 = 50비트**. 수동 입력 fallback(확정 D-1)에서 사람이 칠 수 있는 길이다.
- **타입은 `text` 그대로.** `uuid`로 좁히지 않는 이유: uuid는 36자에 하이픈이 섞여 수동 입력에 최악이고, 혼동 문자(0/O 없음은 다행이나 1/l 문제)를 제어할 수 없다.
- 정규화 함수 `public.qr_normalize_token(text)`: 영숫자 외 문자 제거 → 대문자화 → Crockford 접기(`I,L→1`, `O→0`). **카메라와 수동 입력이 같은 문자열이 되게 만드는 장치**이며, 덕분에 프런트가 `ABCDE FGHJK`처럼 끊어 보여줘도 안전하다.
- **접두어/타입 표시를 넣지 않는다.** 종류는 "어느 컬럼에 매칭됐는가"로 결정된다(아래 1-4). 토큰에 타입을 박으면 payload를 신뢰하는 설계로 미끄러지기 쉽다.

**위협 모델 명시**: 스펙 이슈 3대로 **추측 공격은 위협이 아니다.** 검증 RPC는 관리자만 호출할 수 있고 관리자는 이미 인증 권한자이므로, 토큰을 맞혀서 이득을 얻을 주체가 없다. 50비트는 **무차별 대입 방어가 아니라 우발적 충돌 방지**가 목적이다. (그래서 길이를 늘려 시연을 불편하게 만들지 않는다.)

### 1-2. 생성 주체: 서버(`security definer` RPC)

`public.issue_participation_qr()` 안에서 `public.qr_generate_token()`으로 만든다. 근거:

1. **학생은 애초에 토큰을 쓸 수 없다.** `participations`에 update 정책이 0개이고 insert는 컬럼 단위 grant로 `student_id, program_id`만 허용된다. 즉 서버 생성은 선택이 아니라 유일한 가능한 설계다.
2. 클라이언트 생성이면 학생이 **자기가 아는 값**을 정할 수 있고, 그건 ADR 0004가 `entry_token is null`로 막아둔 공격(토큰 선주입)과 동일하다.
3. 난수원은 `gen_random_uuid()`(v4, CSPRNG, PG13+ 내장). **pgcrypto의 `gen_random_bytes`를 쓰지 않는다** — Supabase는 확장을 `extensions` 스키마에 두는데, `set search_path = ''` 환경에서 그 위치가 환경마다 달라 깨질 수 있다. uuid 32 hex 중 앞 20자를 바이트로 읽어 `& 31`로 인덱싱한다(32는 256의 약수라 모듈로 편향 없음).

### 1-3. 만료: **DB 컬럼**에 둔다 (`entry_token_expires_at`, `exit_token_expires_at` 신규)

ADR 0004가 "DB 컬럼 vs QR payload"로 미뤄둔 결정. **DB 컬럼으로 확정한다.**

- 근거: 스펙이 "검증 판정은 QR payload가 아니라 DB에 저장된 값 기준"을 명시했다. payload의 `expires_at`을 신뢰하면 **학생이 만료를 위조**할 수 있다(payload는 학생 기기에 있다).
- payload의 `expires_at`은 **학생 화면의 30분 카운트다운 표시용**으로만 존재한다. CLAUDE.md 6장이 정의한 payload 구조 `{participation_id, type, expires_at, token}`를 그대로 유지하되, **검증 함수는 `token` 하나만 인자로 받는다**(아래 2-4).
- 값: 발급 시각 + 30분(`now() + interval '30 minutes'`, CLAUDE.md 6장).

### 1-4. 1회용 보장: **토큰을 지우지 않고 상태 전이로 무효화한다**

가장 자연스러워 보이는 방법("성공하면 토큰을 NULL로 지운다")을 **기각했다.** 지우면 재스캔 시 행을 찾지 못해 **`used`(이미 사용됨)와 `not_found`(없는 코드)를 구분할 수 없다.** 스펙이 두 사유를 구분해 표시하도록 요구하므로(CLAUDE.md 6장 4번), 사유 구분을 잃는 대가가 크다.

대신 **소비 조건을 상태에 건다**:

| 토큰 종류 | 소비 가능한 상태 | 소비 후 상태 |
|---|---|---|
| `entry_token` | `applied` | `entered` |
| `exit_token` | `entered` | `completed` |

전이 update가 `where id = ? and status = '이전 상태'` 형태(**CAS**)이므로, 같은 토큰으로 두 번째 전이는 구조적으로 불가능하다. 동시 스캔 2건은 `select ... for update` 잠금으로 직렬화되고, 두 번째는 갱신된 status를 다시 읽어 `used`/`already_completed`로 떨어진다.

- **재발급**: `issue_participation_qr()`은 호출할 때마다 새 토큰으로 덮어쓴다(만료 30분 재시작). 이전 토큰은 어느 행과도 매칭되지 않아 `not_found`로 거부된다 = "재발급 시 이전 토큰 즉시 무효"(스펙 요구사항) 충족. 목록의 QR 버튼과 "다시 발급받기" 버튼이 같은 동작이라 분기가 없다.

### 1-5. unique 제약: **건다** (`entry_token`, `exit_token` 각각)

ADR 0003/0004가 세운 "인덱스를 추가하지 않는다" 원칙의 예외다. 근거는 ADR 0004가 `unique (student_id, program_id)`에 준 것과 동일하다 — **제약의 부산물인 인덱스는 예외**이고, 여기서 막는 것이 실제 사고이기 때문이다: 토큰이 충돌하면 **A 학생의 QR로 B 학생이 완료 처리**된다.

- Postgres unique는 NULL을 여러 개 허용하므로 nullable 컬럼에 그대로 걸린다(partial index 불필요).
- **컬럼 간 충돌(`entry_token` = 다른 행의 `exit_token`)은 unique로 표현할 수 없다.** 그래서 발급 함수에 "생성 → 두 컬럼 전체에서 존재 확인 → 충돌 시 재시도(최대 5회)" 루프를 둔다. 20행 규모에서 비용은 무시 가능하다.
- 검증 함수는 `entry_token`을 먼저 조회하고 없으면 `exit_token`을 조회하는 **결정적 순서**를 쓴다(모호성 원천 차단).

### 1-6. QR payload: **토큰 문자열 하나만 담는다** (2026-08-07 추가 — 1-3의 후속)

1-3은 "payload 구조 `{participation_id, type, expires_at, token}`를 그대로 유지하되 검증 함수는 `token` 하나만
받는다"로 정했다. **그 절반을 되돌린다: 검증에 쓰이지 않는 3개 필드를 payload에서도 뺀다.**

계기는 설계가 아니라 현장 증상이었다 — QR이 눈에 띄게 촘촘하고 카메라가 잘 못 잡는다는 보고(2026-08-07).

- **왜 뺄 수 있는가.** 세 필드는 이미 어디에서도 읽히지 않았다. `participation_id`/`type`은 `extractToken()`이
  명시적으로 버린다(위조 가능한 값이라 검증에 넣지 않는다 — 결정 2-4의 "토큰 자체가 종류를 결정해야 한다"와
  같은 이유). `expires_at`은 학생 화면의 카운트다운 표시용인데, 그 값은 QR이 아니라 **발급 응답**에서 읽는다.
  서버 `verify_participation_qr(p_token)`은 애초에 인자가 토큰 하나다.
- **왜 빼야 하는가.** 4필드 JSON은 약 136바이트 = **QR 버전 7(45×45 모듈)**. 토큰 10자는 Crockford Base32라
  QR 영숫자 모드에 그대로 들어가 **버전 1(21×21 모듈)** 이다. 같은 화면 크기에서 모듈 하나가 2배 이상
  커지므로 카메라 인식이 실제로 빨라진다. 오류 정정도 M → **Q**(15% → 25%)로 올렸는데, 버전 1 영숫자
  용량이 Q에서 16자라 격자를 키우지 않고 얻는다.
- **보안 경계는 줄지 않는다.** 서버가 읽지 않던 값을 빼는 것이라 검증에 쓰이는 정보량이 그대로다.
  1-3의 핵심 주장(**만료 판정의 소유자는 DB 컬럼**)은 오히려 더 명확해진다 — 이제 학생 기기의 payload에
  만료 값이 존재하지도 않는다.
- **부수 효과 1**: 수동 입력 fallback(확정 D-1)용으로 화면에 띄우던 `코드 XXXXXXXXXX`와 QR 내용이
  **글자 단위로 같아진다.** 카메라 경로와 수동 경로가 같은 문자열을 지난다.
- **부수 효과 2**: `extractToken()`의 JSON 분기는 **남겨 둔다.** 이전 형식으로 이미 떠 있는 화면이 그대로
  인식되고, 유지 비용이 `if` 한 줄이다.
- >>> **payload에 필드를 다시 추가하지 말 것.** 추가하는 값은 정의상 서버가 읽지 않는 값이고(읽으면
  위조 가능한 입력을 판정에 쓰는 것 = 1-3 기각 사유), 얻는 것 없이 QR 밀도만 올린다.

---

## 결정 2 — 상태 전이 경로: **`security definer` RPC 2개. RLS update 정책은 0개를 유지한다** (이 ADR 최대 쟁점)

### 2-1. 결론

| 대상 | 이번 결정 |
|---|---|
| `participations` 학생용 update 정책 | **0개 유지** |
| `participations` 관리자용 update 정책 | **0개 — 열지 않는다** |
| `profiles` update 정책 | **0개 유지** |
| `point_transactions` 정책 | **0개(select 포함)** |
| 쓰기 경로 | `public.issue_participation_qr()` / `public.verify_participation_qr()` **둘뿐** |

### 2-2. RLS로는 표현할 수 없는 것 (기각 근거를 정밀하게)

관리자 update 정책을 여는 순간 무엇이 뚫리는지, 그리고 왜 정책으로는 못 막는지:

1. **RLS는 컬럼 단위가 아니다.** `for update`의 `using`은 **OLD 행**을, `with check`는 **NEW 행**을 본다. 그리고 **두 행을 연결하는 수단이 정책 표현식에 없다.** 따라서 "`student_id`는 그대로 두고 `status`만 바꿔라"를 정책으로 쓸 방법이 존재하지 않는다. 관리자가 남의 참여 행의 주인을 자기 담당 학생으로 옮기거나, `program_id`를 3,000P짜리 프로그램으로 바꿔치기할 수 있다.
2. **"유효한 토큰을 제시했을 때만"을 정책으로 표현할 수 없다.** 정책 표현식은 인자를 받지 못한다. 스캔한 토큰 문자열을 정책에 전달할 방법이 없으므로, 정책으로 여는 순간 **토큰 없이도 `completed`로 바꿀 수 있는 권한**이 된다 = 절대 원칙 5의 QR 2회 인증이 통째로 우회된다.
3. **포인트 지급은 남의 `profiles` 행을 수정한다.** 정책으로 하려면 `profiles`에 update를 열어야 하는데, RLS는 컬럼 단위가 아니므로 그 문은 **학생이 자기 `points_balance`를 고치는 문**과 같은 문이다.
4. **원자성.** 상태 전이 + 원장 insert + 잔액 update가 한 트랜잭션이어야 한다("포인트만 오르고 completed가 안 되는" 상태 금지 — 스펙 요구사항). PostgREST 호출 3번은 3개 트랜잭션이다. 함수는 그 자체로 하나의 트랜잭션이다.
5. **거부 사유 구분.** 정책은 403 또는 0행만 돌려준다. 스펙은 6가지 사유를 구분해 관리자 화면에 표시하도록 요구한다.

컬럼 단위 `grant update (status, entry_at)`은 1번만 부분적으로 해결하고 2·3·4·5는 전혀 해결하지 못한다. **따라서 RPC 외의 선택지가 없다.**

### 2-3. 관리자가 `student_id`를 바꿀 수 없는 이유 (질문에 대한 직접적 답)

**정책이 아니라 "함수 안 update 문의 SET 목록"이 경계다.**

- `verify_participation_qr()`의 update는 정확히 `set status = ..., entry_at = ...`(또는 `exit_at`) 두 컬럼만 쓴다. `student_id`/`program_id`/토큰 컬럼은 **문장에 등장하지 않는다.**
- 이 함수는 `student_id`를 **인자로 받지도 않는다.** 관리자가 서버에 넘길 수 있는 값은 토큰 문자열 하나뿐이다.
- `participations`에 update 정책이 0개이므로 **이 함수 밖에는 update 경로 자체가 없다.**

즉 "관리자가 컬럼을 고를 수 있는 지점"이 설계상 존재하지 않는다. RLS가 표현하지 못하는 컬럼 경계를, 서버가 소유한 SQL 문장으로 옮긴 것이다.

### 2-4. 함수 2개의 경계

| 함수 | 호출자 검사 | 행 경계 | 쓰는 컬럼 | 반환 |
|---|---|---|---|---|
| `issue_participation_qr(p_participation_id uuid, p_type text)` | `auth.uid()` not null | `student_id = auth.uid()` | `entry_token(+expires)` 또는 `exit_token(+expires)` **중 하나만** | `{ok, participation_id, type, token, expires_at}` 또는 `{ok:false, reason}` |
| `verify_participation_qr(p_token text)` | `auth.uid()` not null **and `is_admin()`** | `programs.created_by = auth.uid()` (H-1) | `status`+`entry_at`/`exit_at`, `point_transactions` 1행, `profiles.points_*` | `{ok, reason, type, student_name, program_title, points_awarded, at}` |

**발급 함수가 `status`를 절대 쓰지 않는다는 점이 중요하다.** 학생이 이 함수를 아무리 호출해도 참여 상태는 진행되지 않는다. "학생이 자기 토큰을 알아도 스스로 인증할 수 없다"(스펙)가 여기서 성립한다.

**입장/퇴장을 한 함수로 합친 이유**: 카메라는 어떤 종류의 QR이 들어올지 **미리 알 수 없다**. 함수를 분리하면 프런트가 payload의 `type`을 보고 함수를 골라야 하는데, 그건 판정을 위조 가능한 payload에 의존시키는 것이다. 토큰 자체가 종류를 결정해야 한다.

**수동 입력 fallback(확정 D-1)은 같은 함수를 호출한다.** 정규화 함수가 앞단에 있으므로 입력 수단만 다르고 검증은 완전히 동일하다 — 만료·1회용·2회 인증이 그대로다. 절대 원칙 5의 "단순화"(2회를 1회로 줄이거나 검증을 생략)에 해당하지 않는다.

### 2-5. `security definer`의 알려진 함정 처리 (전부 필수)

1. **`set search_path = ''`** 를 5개 함수 전부에 건다. 사용자 객체는 전부 스키마 수식(`public.`, `auth.uid()`). 내장 함수는 `pg_catalog`가 항상 암묵적으로 먼저 검색되므로 수식하지 않아도 안전하다.
2. **`revoke all on function ... from public;` 후 `grant execute ... to authenticated;`** — Postgres 함수의 기본 실행 권한은 `PUBLIC`이다. 회수하지 않으면 **anon 키만 가진 사람도 검증 RPC를 호출**할 수 있다. `qr_generate_token()`은 아무에게도 grant하지 않는다(정의자 권한으로 내부 호출만).
3. **함수 안에서는 RLS가 적용되지 않는다.** 즉 **함수 본문이 곧 권한 경계 전부**다. 그래서 호출자 신원을 본문에서 직접 검사한다.
4. **[중요] Supabase에서 학생과 관리자는 같은 DB 역할(`authenticated`)이다.** `grant`로 역할을 구분할 수 없으므로 "관리자만"은 반드시 본문의 `public.is_admin()` 검사로 표현된다. 이 사실은 아래 결정 6(컬럼 단위 grant를 `profiles`에 쓸 수 없는 이유)에서도 다시 등장한다.
5. 권한 실패는 **예외**(`errcode 42501` → HTTP 403), 도메인 실패는 **`{ok:false, reason}` 반환**으로 분리한다. 학생이 검증 RPC를 호출하면 403이 뜬다(인수 조건 항목).

---

## 결정 3 — 포인트 지급의 멱등성

### 3-1. `point_transactions` 스키마 (확정 C-1)

CLAUDE.md 5장 필드(`id, student_id, type, amount, related_participation_id`) + `created_at`(ADR 0002/0003/0004 전례).

| 컬럼 | 타입 | 제약 |
|---|---|---|
| `id` | uuid | PK |
| `student_id` | uuid | not null, → `profiles(id)` on delete cascade |
| `type` | `point_transaction_type` | not null |
| `amount` | integer | not null, `check (amount > 0)` |
| `related_participation_id` | uuid | → `participations(id)` on delete cascade, **`unique`** |
| `created_at` | timestamptz | not null default now() |

추가 CHECK 1개: `(type='적립' and related_participation_id is not null) or (type='전환' and related_participation_id is null)`.
→ **"출처 없는 적립"이 원장에 존재할 수 없다.** 절대 원칙 3(포인트는 시뮬레이션)과 CLAUDE.md 6장 3번(지급 시점은 퇴장 인증)을 DB로 표현한 것이다.

### 3-2. `type`은 enum, 값은 `'적립'`/`'전환'`

ADR 0003의 판단 기준(**값 집합이 닫혔는가**)을 적용한다. CLAUDE.md 5장이 `type(적립/전환)`으로 2종을 확정했으므로 닫혀 있다 → **enum**(`user_role`, `career_track` 전례와 동일).

값 이름을 `'earn'/'convert'` 같은 ASCII 키로 바꾸는 안을 검토했다(다른 enum들이 전부 ASCII 키 + 프런트 표시명 맵 구조이므로 일관성 논거가 있다). **기각**: `career_track`의 `sci`는 프로토타입이 소유한 기존 키를 옮긴 것이지만, 여기서는 CLAUDE.md가 이미 `적립/전환`을 확정했으므로 ASCII 키를 새로 짓는 건 **없는 taxonomy를 지어내는 것**에 해당한다. 표시명은 여전히 프런트가 소유할 수 있다(값과 표시명이 우연히 같을 뿐이라고 취급할 것).

**`'전환'`은 이번에 생성되지 않는다.** 값 집합만 정의하고, `currency_balance`를 건드리는 코드를 만들지 않는다(마이페이지 스펙 몫).

### 3-3. 이중 지급 방어 — **2중이며 둘 다 DB 제약이다**

1. **1차: CAS 상태 전이.** `update participations set status='completed', exit_at=now() where id=? and status='entered'`. 영향 행이 1이 아니면 즉시 `already_completed` 반환. 동시 스캔은 `for update` 잠금으로 직렬화된다.
2. **2차: `unique (related_participation_id)`.** 1차를 어떤 이유로든 통과했더라도 두 번째 적립 insert는 `23505`로 튕긴다. 함수는 이 예외를 잡아 **서브트랜잭션 전체(상태 전이 포함)를 롤백**하고 `already_completed`를 반환한다.

즉 **재스캔·동시 스캔·네트워크 재시도 어느 경로로도 `points_balance`가 두 번 늘지 않는다.** 확정 C-1이 요구한 "애플리케이션 로직이 아니라 DB에서 튕긴다"가 성립한다.

### 3-4. `profiles.points_*`는 누가 늘리는가

**`verify_participation_qr()` 안의 update 1개뿐이다.** `profiles`에 update 정책을 열지 않는다. 정의자 권한이 RLS를 우회하므로 정책 없이 쓸 수 있고, 이것이 유일한 경로다.

`points_balance`(사용 가능)와 `points_total`(누적)을 **같은 값만큼 함께 증가**시킨다. 둘이 갈라지는 것은 전환('전환')이 생길 때이며 이번 스코프가 아니다.

### 3-5. 한 트랜잭션인가 → **그렇다**

상태 전이 + 원장 insert + 잔액 update가 하나의 plpgsql 블록(서브트랜잭션) 안에 있다. 중간 실패는 전부 롤백된다.

### 3-6. 지급액: **`programs.points`를 서버가 읽고, `point_transactions.amount`에 스냅샷으로 남긴다**

- 클라이언트가 보낸 값을 쓰지 않는다(스펙 요구사항).
- **스냅샷을 남기는 이유가 이번 스코프에서 실제로 생겼다**: 확정 G-3으로 관리자 프로그램 **수정**이 열리면서 `programs.points`가 사후에 바뀔 수 있다. 원장에 금액이 남아 있으므로 이미 지급된 금액은 변하지 않는다.
- **`participations`에 별도 스냅샷 컬럼을 만들지 않는다** — 원장 행이 곧 스냅샷이다. 아카이브/포인트 내역 화면은 `programs.points`가 아니라 `point_transactions.amount`를 읽어야 한다(마이페이지 스펙 시점의 지시).
- **[원칙 1 가드]** 랜덤·배수·연속 참여 보너스 같은 가산 규칙을 넣지 않는다. 정액 그대로다.

---

## 결정 4 — 거부 사유 구분과 정보 노출

`verify_participation_qr()`은 `jsonb`를 반환한다: `{ok, reason, type, student_name, program_title, points_awarded, at}`.

| reason | 발생 조건 | 함께 주는 정보 |
|---|---|---|
| `not_found` | 정규화 후 길이≠10, 또는 어느 컬럼과도 매칭 없음(재발급으로 밀려난 옛 토큰 포함) | **없음** |
| `not_authorized` | `programs.created_by`가 NULL이거나 `<> auth.uid()` (확정 H-1, fail-closed) | **없음** |
| `already_completed` | 참여가 이미 `completed` (또는 CAS/unique 충돌) | 이름·프로그램명 |
| `used` | 입장 토큰인데 이미 `entered` | 이름·프로그램명 |
| `wrong_order` | 퇴장 토큰인데 아직 `applied` | 이름·프로그램명 |
| `expired` | 해당 토큰의 `*_expires_at`이 NULL이거나 지났음 | 이름·프로그램명 |

**검사 순서가 곧 정보 노출 정책이다**: `not_found` → `not_authorized` → (소비 상태) → `expired`. 즉 **"본인이 만든 프로그램"이 확인되기 전에는 어떤 식별 정보도 나가지 않는다.** 확인 후에는 이름·프로그램명을 준다 — 관리자가 학생에게 "다시 발급해 주세요"라고 말하려면 누구인지 알아야 하고, 스펙도 "알 수 있는 범위에서만" 표시를 요구한다.

**공격자에게 정보를 주는가 — 검토 결과**:
- `not_authorized`는 "그 토큰이 유효하게 존재한다"는 사실을 알려준다. 그러나 (a) 호출자는 이미 인증된 관리자이고, (b) 누구의 무엇인지는 알 수 없으며, (c) 이 사유를 `not_found`로 뭉개면 스펙이 요구한 사유 구분이 깨진다. **수용**한다.
- 소비 상태 검사를 만료보다 **먼저** 한다(`used`가 `expired`보다 우선). 이미 쓰인 토큰의 만료 여부는 알려줄 필요가 없다.
- `camera_error`/`network_error`는 서버 사유가 아니라 **프런트가 만드는 별도 분류**다. 인증 거부와 섞지 말 것(스펙 명시).

권한 실패(비로그인, 학생이 호출)는 reason이 아니라 **예외 `42501`/HTTP 403**이다. 프런트는 이 경우를 "인증 거부"가 아니라 "권한 오류"로 표시한다(정상 사용에서는 발생하지 않는다 — 발생하면 버그).

---

## 결정 5 — stackviz 데이터 소스 (확정 B-1)

**새 정책 0개.** 기존 `participations_select_own`으로 충분하다. RLS는 행 단위이므로 보이는 행의 **모든 컬럼**(`status`, `exit_at` 포함)을 읽을 수 있다.

- 조회: `select id, program_id, status, exit_at from participations` → 클라이언트에서 `status === 'completed'`만 남긴다.
- **월 버킷 기준은 `programs.date`**(활동이 일어난 달). `exit_at`이 아니다 — 마일스톤은 "언제 활동했는가"이고, 프로그램 상세와 같은 날짜 축을 써야 화면끼리 어긋나지 않는다. 날짜 계산은 `src/lib/date.js`의 로컬(KST) 기준 유틸을 쓴다(`toISOString()` 금지).
- **뷰를 만들지 않는다.** ADR 0003 6번 / ADR 0004 5번의 정의자 권한 함정 그대로 — 뷰는 기본이 owner 권한이라 `participations_select_own` 경계를 우회해 **다른 학생의 참여 내역이 새는 뷰**가 만들어진다. `programs`는 이미 클라이언트가 들고 있으므로 클라이언트 결합으로 끝난다.
- **[알려진 틈]** 게시중단된(`is_published=false`) 프로그램은 학생이 읽을 수 없으므로, 그 프로그램의 완료 블록은 stackviz에서 카테고리/월을 결정할 수 없다. 아래 결정 7-4 참고.
- **[원칙 1 가드]** 블록에 숫자·레벨·게이지·"N개 달성" 라벨 금지. 채워진 블록 색은 교내=brand blue / 교외=indigo, **amber 금지**(포인트 그래프로 오독 방지).

---

## 결정 6 — `participations_insert_own` 재검토 + 컬럼 단위 insert grant 채택

ADR 0004가 "컬럼이 추가되면 이 `with check`를 반드시 함께 재검토할 것"이라고 지목한 자리다. 두 가지를 함께 한다.

### 6-1. `with check`를 6절 → 9절로 확장 (컬럼 봉인 2절 + **관리자 자기참여 차단 1절**)

**(a) 만료 컬럼 봉인** — `and entry_token_expires_at is null and exit_token_expires_at is null`. 만료 컬럼만 위조한 토큰은 (토큰 자체를 심을 수 없으므로) 실제로는 무해하지만, **"컬럼이 생기면 그때 함께 봉인한다"는 규율을 여기서 깨면 다음 컬럼에서 진짜 구멍이 생긴다.**

**(b) `and not public.is_admin()` — 확정 G-3이 새로 만든 폐루프를 끊는다. 이번 설계 검토에서 발견한 항목이다.**

관리자에게 `programs` insert 권한이 열리는 순간, **관리자 한 계정만으로 포인트를 무한히 찍어내는 경로**가 성립한다:

| 단계 | 이전 스코프 | G-3 이후 |
|---|---|---|
| 1. 3,000P짜리 프로그램을 만든다 (`created_by`=본인) | **불가능**(정책 없음) | `programs_insert_own_as_admin`으로 가능 |
| 2. 그 프로그램에 자기 이름으로 신청한다 | 가능(`student_id = auth.uid()`를 만족한다 — 관리자도 `profiles` 행이 있다) | 〃 |
| 3. 자기 QR을 발급받는다 | 해당 없음 | `issue_participation_qr`(본인 참여 건이라 통과) |
| 4. 자기가 스캔해 완료 처리한다 | 해당 없음 | `verify_participation_qr`(`created_by`=본인이라 H-1 통과) |

**1단계가 막혀 있어 성립하지 않던 루프가, G-3으로 1단계가 열리면서 닫힌 고리가 된다.** H-1(스캔은 본인 프로그램만)은 이 경우 방어가 아니라 **오히려 통과 조건**이 된다는 점이 함정이다.

→ **2단계를 끊는다.** `not public.is_admin()`은 도메인적으로도 맞다 — CLAUDE.md 4장에서 신청은 student의 행위이고 admin은 등록/스캔/조회만 한다. 관리자가 학생 계정으로 신청하는 것은 여전히 가능하지만 그건 학생 계정의 권한이고 QR 2회 인증도 그대로다.

이 절 때문에 `is_admin()`은 **`participations_insert_own`보다 먼저 생성**되어야 한다(`docs/db/schema.sql`에서 `profiles` 바로 뒤 1-1로 배치).

### 6-2. 컬럼 단위 insert grant 채택 (ADR 0004가 "QR 스펙 시점이 이 방법의 원래 자리"라며 미뤄둔 것)

```
revoke insert on public.participations from authenticated;
revoke insert on public.participations from anon;
grant  insert (student_id, program_id) on public.participations to authenticated;
```

ADR 0004는 이 방법을 "이론적으로 가장 강하지만 지금은 이득이 적다"며 기각하고, **컬럼이 더 늘고 update가 열리는 이 시점**을 재검토 자리로 지목했다. 이번에 실제로 컬럼이 2개 늘었고 앞으로도 는다(reviews/notifications 스펙). 채택 근거:

- **fail-closed**: 앞으로 어떤 컬럼이 추가돼도 학생은 쓸 수 없다. 정책 개정을 잊어도 구멍이 생기지 않는다.
- ADR 0004가 "알려진 틈"으로 수용했던 **`created_at` 위조와 `id` 지정이 함께 닫힌다.**
- 비용(권한 모델이 grant + RLS 이중이 되어 "왜 거부됐는가"의 출처가 둘)은 그대로 남는다. 그래서 마이그레이션과 `schema.sql`에 **둘 다 42501/403이라 구분되지 않는다**는 점을 명시하고, 프런트 규율("insert에 `student_id`/`program_id` 외 어떤 컬럼도 보내지 않는다")을 유지한다. `src/lib/programService.js`의 `applyToProgram`은 이미 그렇게 되어 있어 코드 변경이 없다.
- `supabase-js`의 `.insert().select()`(RETURNING)는 select 권한을 쓰므로 계속 동작한다. `service_role`은 별도 역할이라 영향받지 않는다(시딩/리셋 무관).

### 6-3. `exists(... is_published = true)` 서브쿼리 — **ADR 0004가 예고한 함정을 실제로 확인했다**

확정 G-3으로 `programs`에 "관리자는 본인이 만든 미게시 행도 select 가능" 정책이 추가된다(결정 7-1). ADR 0004는 이 순간을 예고하며 서브쿼리에 `p.is_published = true`를 **명시적으로 다시 걸어**두었다.

**검토 결과: 그 방어가 설계대로 작동한다.**
- 정책 표현식은 질의자 권한으로 평가되므로, 관리자가 스스로 신청을 시도하면 이 서브쿼리는 새 정책 덕에 **자기 미게시 프로그램을 보게 된다.**
- 그러나 `and p.is_published = true`가 명시돼 있어 결과는 여전히 거부다.
- **그 절이 없었다면** 관리자가 자기 미게시 프로그램에 자기 이름으로 신청할 수 있었다(그 뒤 자기 QR을 자기가 인증하는 폐루프까지 이어진다).
- → 이 절을 "RLS가 어차피 막아준다"며 지우지 말 것. 마이그레이션 주석에 이 확인 결과를 남긴다.

---

## 결정 7 — 관리자 권한 경계 (확정 G-3: 관리자 기능 3종 전부)

### 7-0. 행 경계는 두 축뿐이다

| 축 | 표현 | 쓰이는 곳 |
|---|---|---|
| **A. 운영 축** | `programs.created_by = auth.uid()` | 프로그램 관리(미게시 select / insert / update) + **QR 스캔(확정 H-1)** |
| **B. 멘토링 축** | `mentor_students(admin_id = auth.uid())` | 담당 학생 아카이브(`profiles`, `participations`) |

**두 축을 섞지 않는다.** 확정 H-1의 근거가 정확히 이것이다 — "현장 운영자 = 그 프로그램을 올린 관리자"이고, `mentor_students`는 아카이브 조회용 축이지 운영 축이 아니다.

**프로그램 관리도 축 A로 통일한다.** "전체 허용"을 기각한 이유:
- 축이 어긋나면 **"내가 스캔할 수 없는 프로그램을 내가 수정할 수 있다"**는 조합이 생긴다. 특히 남의 프로그램의 `points`를 3,000P로 올려두고 그 관리자가 스캔하게 만드는 간접 경로가 열린다.
- ADR 0003이 "지금 정하면 추측"이라며 미뤄둔 결정인데, 이제 스펙(H-1)이 축을 지정했으므로 추측이 아니다.
- 데모에서 관리자가 1명이라 두 안의 결과가 같지만, 그렇다고 넓은 쪽을 고를 이유가 없다(ADR 0003의 논리 그대로).

`created_by`가 NULL이면 **모든 관리자에게 거부**된다(RLS에서 `NULL = auth.uid()`는 참이 아니고, `verify_participation_qr`은 명시적으로 `not_authorized`). 확정 H-1의 fail-closed 요구와 일치한다.

### 7-1. `programs` — 정책 3개 추가, delete는 열지 않는다

| 정책 | 종류 | 경계 |
|---|---|---|
| `programs_select_own_as_admin` | select | `created_by = auth.uid()` (게시 여부 무관) |
| `programs_insert_own_as_admin` | insert | `is_admin() and created_by = auth.uid()` |
| `programs_update_own_as_admin` | update | using/with check 모두 `is_admin() and created_by = auth.uid()` |

- select 정책은 기존 `programs_select_published`와 **OR로 합쳐진다** → 관리자는 "게시된 전부 + 본인이 만든 미게시"를 본다. 다른 관리자의 미게시는 못 본다.
- **insert에 `is_admin()`이 반드시 필요하다.** 없으면 **학생이 `created_by=본인`으로 프로그램을 만들 수 있고**, 그러면 자기 프로그램에 자기가 신청하고 자기 QR을 자기가 인증하는 폐루프가 생긴다(포인트 무한 발행). 이 절이 이번 변경에서 가장 조용하지만 중요한 한 줄이다.
- update의 `with check`가 **소유권 이전과 NULL화를 막는다**(수정 후에도 `created_by = auth.uid()`여야 한다).
- **delete 정책은 열지 않는다.** CLAUDE.md 10장의 "내리기"는 `is_published=false` 토글이지 삭제가 아니다. 게다가 `programs` 삭제는 `on delete cascade`로 학생의 `participations`와 `point_transactions`까지 지우는데 `profiles.points_*`는 남아 **잔액과 원장이 어긋난다.** 삭제는 시연 리셋(service_role) 전용.
- **컬럼 경계는 열려 있다(수용).** RLS가 컬럼 단위가 아니므로 관리자는 본인 프로그램의 모든 컬럼을 바꿀 수 있다(`points` 포함). 부정 적립 경로가 되지 않는 이유:
  1. 지급액은 지급 시점 스냅샷으로 원장에 남는다(결정 3-6).
  2. **관리자는 `participations`를 만들 수 없다** — 남의 참여는 `student_id = auth.uid()`가, **자기 참여는 결정 6-1(b)의 `not is_admin()`이** 막는다. 즉 "고액 프로그램 + 참여 조작 + 완료 처리" 폐루프가 성립하지 않는다. **이 두 절 중 하나만 빠져도 관리자 무한 적립이 열린다.**
  3. `points`의 150~3000/끝자리 0은 테이블 CHECK가 막는다(이번에 처음으로 "사람이 입력한 값"을 막게 된다 — 위반 시 `23514`/400).

### 7-2. 담당 학생 아카이브 — `mentor_students` + `profiles` + `participations` 정책 3개

```
mentor_students_select_own_as_admin        : using (admin_id = auth.uid())
profiles_select_mentored_students_as_admin : using (is_admin() and exists(ms: admin_id=me, student_id=profiles.id))
participations_select_mentored_as_admin    : using (is_admin() and status='completed' and exists(ms: ...))
```

**(a) 재귀 위험을 반드시 이 구조로 피해야 한다.**
`profiles` 정책 안에서 `profiles`를 select하면 Postgres가 **정책 재귀 에러**를 낸다. 그래서 "호출자가 관리자인가"는 `security definer` 헬퍼 `public.is_admin()`으로 표현한다(정의자 권한이라 RLS를 타지 않는다 → 재귀 없음). 이건 Supabase의 표준 패턴이며, **편의가 아니라 이 정책을 작성 가능하게 만드는 유일한 방법**이다.
그리고 **`mentor_students` 정책에 `profiles` 조인을 넣지 말 것** — 넣는 순간 `profiles ↔ mentor_students` 정책이 서로를 부르는 순환이 된다. 현재 구조는 `profiles → mentor_students → (끝)`으로 단방향이다.

**(b) 무엇이 막히는가**
- 학생 ↔ 학생: `is_admin()`이 즉시 거짓 → 차단(변화 없음).
- 관리자 A ↔ 관리자 B의 담당 학생: `admin_id` 축이 다름 → 차단.
- 관리자 ↔ 담당이 아닌 학생: 매핑 없음 → 차단.
- 관리자 ↔ 다른 관리자의 `profiles`: 매핑에 없음 → 차단.

**(c) 수용하는 것 — 컬럼 경계를 좁히지 못한다**
이 정책은 담당 학생 행의 **모든 컬럼**을 연다(`points_balance`, `currency_balance`, `career_interest` 포함). 컬럼 단위 grant로 좁힐 수 없다: **Supabase에서 학생과 관리자가 같은 DB 역할(`authenticated`)이라, 컬럼 grant를 걸면 학생 본인 조회까지 함께 막힌다.** 좁히려면 아카이브 전체를 definer RPC로 옮겨야 하는데, "**조회는 RLS, 쓰기는 RPC**"라는 이 프로젝트의 구조를 아카이브 하나 때문에 깨는 비용이 더 크다고 판단했다(정렬·필터까지 서버로 넘어간다).
→ **[원칙 1 가드 — frontend 필수]** 담당 학생들의 포인트를 나란히 놓고 비교·정렬·순위로 렌더하지 말 것. 아카이브는 **학생 1명 단위**의 활동 기록 화면이다.

**(d) `participations`에 `status = 'completed'`를 정책에 박는 이유**
"무엇을 신청했다가 안 갔는가"는 아카이브가 보여줄 정보가 아니라 학생의 사생활에 가깝다. 화면이 어떤 필터를 걸든 **DB가 완료분 외에는 내려주지 않는 편이 경계가 명확하다.** ADR 0004가 그은 선("권한 경계는 DB, 신청 가능 여부는 프런트")의 DB 쪽에 해당한다.
부수 효과: 관리자가 볼 수 있는 참여가 담당 5명의 완료분뿐이라 **프로그램별 참여자 수·출석률·전교생 랭킹은 애초에 데이터를 얻을 수 없다**(원칙 1·6이 UI 규율이 아니라 RLS 구조로 성립).

**(e) 스펙 "이슈 2"의 개정을 명시한다.**
스펙 이슈 2와 인수 조건은 G-1 전제로 "관리자가 `participations`/`profiles`를 목록 조회할 수 없다"고 적었다. **G-3에서 이 문장은 "관리자는 담당 학생 5명의 `profiles`와 그들의 `completed` 참여만 조회할 수 있다"로 개정된다.** QA는 개정된 경계로 검증할 것. 스캔 화면 쪽 요구(스캔 결과의 이름/프로그램명을 RPC 반환값으로만 준다)는 **그대로 유효하다** — 스캔 대상 학생이 담당 학생이 아닐 수 있기 때문이다.

**(f) 새로 생긴 의존성**: `mentor_students`의 시딩 정합성(관리자 자리에 학생이 들어가지 않는 것)이 이제 **권한 경계의 일부**다. ADR 0002는 이를 트리거 없이 시딩 스크립트 책임으로 뒀는데, 그 판단이 이제 실제 노출과 연결된다. 다만 `is_admin()`이 함께 걸려 있어 "학생이 admin_id 자리에 잘못 들어가도 남의 profiles를 못 본다" — **이중 방어가 성립하므로 트리거를 추가하지 않는다.**

### 7-3. PDF 확인 — 새 권한 0개

담당 학생 아카이브 PDF는 위 정책들로 **이미 조회한 데이터를 클라이언트에서 렌더/인쇄**한다. 라이브러리 선택·인쇄 CSS는 frontend 판단.
**서버 렌더가 필요하다는 결론이 나오면 그것은 `service_role`을 쓰겠다는 뜻이고 = RLS 밖으로 나가는 설계다 → 금지.** 그 결론이 나오면 설계를 다시 볼 것(스펙도 같은 판단).

### 7-4. 게시중단(`is_published=false`)이 이미 신청한 학생에게 미치는 영향 — 판단

| 항목 | 결과 |
|---|---|
| `participations` 행 | **남는다.** `participations` 정책 어디에도 `is_published`가 없다. 신청이 사라지지 않는다 |
| QR 발급 | **된다.** `issue_participation_qr()`은 `programs`를 보지 않는다 |
| QR 검증·포인트 지급 | **된다.** definer라 RLS를 우회하고, 게시 여부를 판정에 쓰지 않는다(경계는 `created_by`뿐) |
| 학생 화면의 프로그램 정보 | **깨진다.** 학생은 그 `programs` 행을 select할 수 없다 → QR 목록의 제목, stackviz의 카테고리/날짜를 찾지 못한다 |

**결론: 게시중단은 "신규 신청을 막는 것"이고 진행 중인 참여의 인증 흐름을 끊지 않는다.** 표시 열화는 **알려진 틈으로 수용**한다.

"내가 신청한 프로그램은 미게시여도 볼 수 있다"는 학생용 select 정책을 검토했으나 **기각**: 그 정책은 `programs → participations`를 참조하고 `participations_insert_own`은 `participations → programs`를 참조해 **정책끼리 상호 참조**가 된다(현재는 종료되지만 매우 취약하다 — 한쪽만 바뀌어도 재귀가 된다). 20행 데모에서 그 위험을 사는 대신, **프런트가 프로그램 정보를 찾지 못한 경우에도 죽지 않도록 방어**한다(구현 가이드). 신청자가 있는 프로그램을 게시중단하는 시연은 이 열화를 인지하고 할 것.

### 7-5. 관리자 홈 "오늘 진행 프로그램" — 새 정책 0개

기존 `programs_select_published`(+ 7-1의 own 정책)만으로 조회된다. 클라이언트에서 `created_by === 본인 && date === 오늘`로 거른다.

- **`created_by` 필터를 프런트가 거는 이유**: H-1 때문에 남의 프로그램은 스캔이 항상 실패한다. 목록에 띄우면 "누르면 반드시 실패하는 버튼"이 된다. 데모에서는 20건 전부 ADM-0001이라 결과가 같다.
- 날짜는 `src/lib/date.js`의 `todayISO()`(로컬/KST). **DB에서 `current_date`로 거르지 않는다** — ADR 0003 6번/ADR 0004의 타임존 판단 유지(정책·쿼리에 날짜를 박으면 소스가 갈린다).
- **[원칙 1·6 가드]** 관리자 홈에 참여자 수·신청자 명단·출석률·학생 랭킹·학교 단위 통계를 표시하지 않는다. 7-2(d)에 따라 데이터도 얻을 수 없다.

---

## 결정 8 — 시드

### 8-1. `dayOffset: 0` 프로그램 2건 (교내 1 + 교외 1) — **기존 행 2건의 날짜를 옮긴다(추가하지 않는다)**

확정 G-3의 부수 작업은 "시드에 `dayOffset: 0` 프로그램 2건 추가"다. 그런데 **`scripts/seed-programs.mjs`는 현재 정확히 20건이고, ADR 0003 확정 F가 "16~20개"로 확정돼 있으며 스크립트의 `assertSeedInvariants()`가 `rows.length > 20`이면 실행을 중단시킨다.** 2건을 그냥 추가하면 22건이 되어 다른 확정 결정과 충돌한다.

**결정: 기존 행 2건의 `dayOffset`을 0으로 바꾼다.** 관측 가능한 요구("관리자 홈에 오늘 진행 프로그램이 교내 1 + 교외 1로 뜬다")를 100% 충족하면서 확정 F를 건드리지 않는다. 대상(가장 가까운 미래 2건, 둘 다 게시·`open`):

| 현재 | 카테고리 | 그룹 | 변경 |
|---|---|---|---|
| `또래 멘토링 프로그램` (상담부) | `het` | 교내 | `dayOffset: 2 → 0` |
| `지역 연계 진로 박람회` (OO교육지원청) | `eet` | 교외 | `dayOffset: 4 → 0` |

부수 영향 확인: 학생 홈 추천은 `date >= 오늘`이라 그대로 포함된다. 프로그램 선택 화면의 "지난 프로그램" 그룹 분류도 바뀌지 않는다(오늘 = 지난 아님). 시드 자체 검증의 `publishedFuture`/`primaryMatches`/`past` 카운트 모두 영향 없음.
→ 이 판단은 아래 **"케빈 확인 필요 1번"**으로 표시한다(대안: 2건을 추가하고 확정 F 상한을 22로 개정).

### 8-2. `assertSeedInvariants()`에 검사 1개 추가

`dayOffset === 0`인 행이 **교내 1건 이상 + 교외 1건 이상**임을 검증한다(없으면 중단). 없으면 관리자 홈이 항상 빈 상태가 되는데, 그건 시드가 조용히 깨진 것이지 화면 버그가 아니다. 교내/교외 판정은 카테고리 첫 글자(`h`/`e`)로 한다.

### 8-3. 그 외 시드는 변경 없음

- `mentor_students` 5행은 `seed-accounts.mjs`가 이미 넣는다 → 담당 학생 아카이브에 **추가 시드 불필요**.
- 미게시 행 1건이 이미 있고 `created_by = ADM-0001`이므로 **프로그램 관리의 "미게시 조회/다시 올리기" 시연이 그대로 된다.**
- `participations`/`point_transactions`는 **시드하지 않는다**(ADR 0004: 가짜 데이터를 하드코딩하지 않는다). 아카이브에 보이는 데이터는 이 스펙의 QR 인증이 만든다 → **구현·시연 순서는 QR 먼저, 아카이브 나중.**

---

## RLS/권한 영향 (한눈에)

### 이번에 추가되는 정책: 신규 6개 + 개정 1개(`participations_insert_own`) / 함수: 5개 / 컬럼 grant: 1건

| 대상 | 정책 이름 | 종류 | 경계 |
|---|---|---|---|
| `programs` | `programs_select_own_as_admin` | select | `created_by = auth.uid()` |
| `programs` | `programs_insert_own_as_admin` | insert | `is_admin() and created_by = auth.uid()` |
| `programs` | `programs_update_own_as_admin` | update | 〃 (using + with check 양쪽) |
| `mentor_students` | `mentor_students_select_own_as_admin` | select | `admin_id = auth.uid()` |
| `profiles` | `profiles_select_mentored_students_as_admin` | select | `is_admin()` + 담당 매핑 |
| `participations` | `participations_select_mentored_as_admin` | select | `is_admin()` + 담당 매핑 + `status='completed'` |

| 함수 | 종류 | execute |
|---|---|---|
| `public.is_admin()` | definer, stable | `authenticated` |
| `public.qr_normalize_token(text)` | invoker, immutable | `authenticated` |
| `public.qr_generate_token()` | invoker, volatile | **없음**(내부 전용) |
| `public.issue_participation_qr(uuid, text)` | **definer** | `authenticated` (본문에서 본인 확인) |
| `public.verify_participation_qr(text)` | **definer** | `authenticated` (본문에서 `is_admin()` + H-1) |

### 이번에도 **열지 않는** 것 (의도적)

- `participations` **update / delete 정책 — 학생·관리자 모두 0개.** 이 ADR의 핵심.
- `profiles` **update 정책 0개.** 포인트는 정의자 함수만 늘린다.
- `point_transactions` **정책 0개(select 포함).** 학생 포인트 내역 화면이 아직 없다 → 마이페이지 스펙에서 `point_transactions_select_own`을 열 자리.
- `programs` **delete 정책 0개.**
- `mentor_students` **insert/update/delete 정책 0개.**
- **관리자용 `participations` 전체 조회·집계 권한 없음**(담당 5명 완료분만).

### 공격 경로 대조표

| 공격 경로 | 차단 장치 | 결과 |
|---|---|---|
| 학생이 자기 참여를 `completed`로 update | update 정책 0개 | 0행 영향 |
| 학생이 `entry_at`/토큰/만료를 insert에 심기 | with check 9절 + 컬럼 단위 insert grant | 42501/403 |
| 학생이 `points_balance` 직접 수정 | `profiles` update 정책 0개 | 0행 영향 |
| 학생이 `point_transactions`에 직접 적립 insert | 정책 0개 | 0행/403 |
| 학생이 검증 RPC 직접 호출 | 함수 본문 `is_admin()` | 42501/403 |
| 학생이 남의 참여 건 토큰 발급 | 함수 본문 `student_id = auth.uid()` | 42501/403 |
| 학생이 프로그램 등록 | `programs_insert_own_as_admin`의 `is_admin()` | 42501/403 |
| 관리자가 `student_id`를 다른 학생으로 변경 | update 정책 0개 + 함수 SET 목록에 없음 | 경로 자체가 없음 |
| 관리자가 토큰 없이 완료 처리 | 정책 없음, 함수는 토큰만 인자로 받음 | 경로 자체가 없음 |
| 관리자 A가 관리자 B의 프로그램 QR 인증 | `created_by = auth.uid()` (H-1, NULL fail-closed) | `not_authorized` |
| 관리자가 남의 프로그램 수정/소유권 이전 | `programs_update_own_as_admin` using + with check | 0행/403 |
| 관리자가 전교생 참여·프로필 열람 | 담당 매핑 + `status='completed'` 경계 | 0행 |
| 관리자가 자기 미게시 프로그램에 자기가 신청 | `participations_insert_own`의 `p.is_published = true` | 42501/403 |
| **관리자가 고액 프로그램을 만들어 자기가 신청·자기가 완료 처리(무한 적립)** | `participations_insert_own`의 `not is_admin()` (결정 6-1(b)) | 42501/403 |
| 만료 QR 스캔 | `*_expires_at` (DB 값 기준) | `expired` |
| 같은 QR 재스캔 | CAS(`where status = 이전상태`) | `used`/`already_completed` |
| 동시 스캔 2건 | `for update` 잠금 + CAS + unique | 1건만 성공 |
| 이중 지급(재시도·경합) | `unique (related_participation_id)` + 예외 시 전체 롤백 | 23505 → `already_completed` |
| 입장 없이 퇴장 | 발급 시 `wrong_order` + 검증 시 `wrong_order` | 거부(2중) |
| QR payload의 `expires_at` 위조 | 판정을 DB 컬럼으로만 함 | 무효 |
| 임의 문자열 스캔 | 정규화 후 길이/매칭 검사 | `not_found` |
| anon 키로 RPC 호출 | `revoke execute from public` + `auth.uid()` null | 403 |

---

## 대안으로 고려했던 것

- **관리자에게 `participations` update 정책 부여**: RLS는 컬럼 단위가 아니고 OLD/NEW를 연결할 수 없어 `student_id` 보호를 표현 불가. 토큰 검증도 정책 표현식에 인자를 못 넘겨 불가능. **기각**(결정 2-2).
- **학생에게 update 정책 부여(토큰 발급용)**: 학생이 자기 토큰 값을 정할 수 있게 되고, `status`까지 열리면 QR 2회 인증이 통째로 우회된다. **기각.**
- **컬럼 단위 `grant update (status, entry_at)` + 관리자 정책**: 컬럼 경계는 해결하지만 "유효한 토큰을 제시했을 때만"·원자성·사유 구분을 전혀 해결하지 못한다. **기각.**
- **`before update` 트리거로 컬럼 변경 차단**: 조용히 덮어쓰거나 예외를 던지는데, 어차피 update 진입점 자체를 열어야 한다. 진입점을 안 여는 편이 단순하다. **기각.**
- **토큰 사용 시 NULL로 지우기**: `used`와 `not_found`를 구분할 수 없게 되어 스펙의 사유 표시 요구를 깬다. **기각**(결정 1-4).
- **`*_token_used_at` 컬럼 추가**: 사용 여부를 명시적으로 기록하는 안. 그러나 사용 여부는 `status`에서 **완전히 파생 가능**하고(입장 토큰은 `applied`에서만, 퇴장 토큰은 `entered`에서만 소비된다), 컬럼 2개가 늘면 `with check`도 2절 늘어난다. 파생 가능한 상태를 중복 저장하면 둘이 어긋날 자리가 생긴다. **기각.**
- **별도 `participation_tokens` 테이블**(발급 이력 + 단일 unique + used_at): 가장 정석적이고 컬럼 간 충돌 문제도 사라진다. 그러나 **CLAUDE.md 5장·스펙 어디에도 없는 테이블**이라 임의 추가에 해당하고, `participations`에 토큰 컬럼 4개를 이미 만들어 봉인해 둔 ADR 0004의 결정과 충돌한다(그 컬럼들이 죽은 컬럼이 된다). 데모 규모에 이력 추적 요구도 없다. **기각.**
- **만료를 QR payload에만 두기**: 학생 기기의 값을 판정에 쓰는 것이라 위조 가능. **기각**(스펙 명시).
- **검증 RPC를 입장/퇴장 2개로 분리**: 카메라가 종류를 미리 알 수 없어 프런트가 payload의 `type`을 믿고 골라야 한다 = 판정을 위조 가능한 값에 의존. **기각.**
- **검증 RPC에 `program_id`를 함께 넘겨 "지금 이 프로그램의 QR인지" 확인**: 선택자가 둘이 되어 불일치 처리(무엇을 우선?)가 늘고, H-1이 이미 행 경계를 정한다. 대신 반환값의 `program_title`로 관리자가 눈으로 확인한다. **기각.**
- **`point_transactions.type`을 text + CHECK**: ADR 0003의 판단 기준(값 집합이 닫혔는가)에 따르면 enum. `user_role`/`career_track` 전례와도 일치. **기각.**
- **`type` 값을 `'earn'/'convert'` ASCII 키로**: 다른 enum이 전부 ASCII 키라는 일관성 논거가 있으나, CLAUDE.md 5장이 `적립/전환`을 이미 확정했으므로 새 키를 짓는 것은 없는 taxonomy를 지어내는 것. **기각**(결정 3-2).
- **`point_transactions`를 만들지 않고 `status='completed'` 검사만으로 이중 지급 방어**(C-2): 확정 C-1이 배제. 멱등성 방어가 상태 전이 하나에 전부 걸린다. **기각.**
- **`participations`에 `points_awarded` 스냅샷 컬럼 추가**: 원장 행이 이미 스냅샷이다. 중복 저장. **기각.**
- **포인트 지급을 `after update` 트리거로**: 지급 로직이 상태 전이에 숨어 보이지 않게 되고, 트리거는 어떤 update 경로에서든 실행되므로 나중에 update 정책이 열리면 함께 뚫린다. 지급은 명시적 함수 안에 있어야 한다. **기각.**
- **관리자 자기참여 폐루프를 `verify_participation_qr` 쪽에서 막기**(`if v_p.student_id = v_admin then not_authorized`): 동작은 하지만 **관리자의 참여 행이 DB에 남는다**(학생 화면에도 안 뜨는 유령 행). 신청 단계에서 끊는 편이 상태가 깨끗하고, "신청은 학생의 행위"라는 도메인 규칙과도 일치한다. **기각**(결정 6-1(b)).
- **`participations_insert_own`에 `not is_admin()` 대신 `exists(profiles where id=auth.uid() and role='student')`**: 긍정형이라 더 fail-closed해 보이지만, 그 서브쿼리는 `profiles`의 RLS를 타므로 `profiles_select_own`에 의존하게 되고 정책 간 결합이 는다. `is_admin()`은 definer라 그 의존이 없다. 프로필 행이 아예 없는 사용자는 `student_id` FK가 막는다. **기각.**
- **`programs` 관리자 정책을 "전체 허용"으로**: 축 A(H-1)와 어긋나 "스캔 못 하는데 수정은 되는" 조합이 생기고, 남의 프로그램 `points`를 조작하는 간접 경로가 열린다. **기각**(결정 7-0).
- **아카이브를 `security definer` RPC로**(컬럼 노출 최소화): 최소 권한 면에서는 우수하나 "조회는 RLS, 쓰기는 RPC" 구조를 깨고 정렬·필터가 서버로 넘어간다. **기각**(결정 7-2(c)), 대신 원칙 1 프런트 가드로 보완.
- **관리자 아카이브에 `mentor_students` 대신 `created_by` 축 사용**: 운영 축과 멘토링 축을 섞는 것. 확정 H-3 기각 사유와 동일. **기각.**
- **"내가 신청한 프로그램은 미게시여도 select 가능" 학생 정책**: 정책 간 상호 참조가 생겨 재귀 취약. **기각**(결정 7-4).
- **시드에 `dayOffset: 0` 2건을 추가(=22건)**: 확정 F(16~20)와 시드 자체 검증을 함께 고쳐야 한다. 기존 2건의 날짜를 옮기는 쪽이 관측 결과가 같으면서 다른 확정을 건드리지 않는다. **기각(단, 케빈 확인 필요 1번).**
- **아카이브 시연용 `completed` 참여 시드**: ADR 0004의 "가짜 참여를 하드코딩하지 않는다"와 충돌하고, `point_transactions` + `profiles.points_*`까지 정합을 맞춰야 한다. **기각(단, 케빈 확인 필요 2번).**

---

## 향후 변경 (이번 스코프 아님, 예정만 기록)

> **[2026-07-30 갱신]** 아래 4개 항목(`reviews` / 마이페이지·포인트 내역·지역화폐 전환 / `profiles` 본인 수정 / 학생 아카이브)은
> **`docs/adr/0007-mypage-ledger-reviews-and-profile-write-paths.md`로 전부 회수됐다.** 예고 내용은 그대로 지켜졌다 —
> `point_transactions`에는 select 정책 1개만 열렸고, 전환과 계열 저장은 둘 다 `security definer` RPC이며,
> **`profiles`의 update 정책은 여전히 0개다.** 다만 결정 3-4의 문장은 범위가 개정됐다:
> "늘리는" 유일한 경로는 여전히 `verify_participation_qr()`이고, 이번에 **"줄이는" 경로**(`convert_points_to_currency()`)와
> **계열을 바꾸는 경로**(`set_career_interest()`)가 추가됐다. 컬럼별 writer 표는 ADR 0007 결정 3-6에 있다.

- **[회수 완료 → ADR 0007]** **`reviews`(만족도 평가)**: 확정 B-1이 미뤘다. 퇴장 완료 화면에 훅 지점 주석을 남긴다(CLAUDE.md 6장 3번은 미구현이지 삭제가 아니다). 아카이브 스펙에서 함께 만든다. `participations`에 컬럼이 추가되면 **또 `participations_insert_own`을 재검토해야 한다** — 다만 이번에 채택한 컬럼 단위 insert grant 덕에 학생 쓰기는 이미 fail-closed다.
- **`notifications`**: 확정 B-1이 미뤘다. 입·퇴장 인증이 알림 이벤트의 첫 소스가 될 것이다.
- **[회수 완료 → ADR 0007]** **마이페이지 / 포인트 내역 / 지역화폐 전환**: `point_transactions_select_own` 정책을 열 자리. 전환은 `type='전환'` 행 생성 + `points_balance` 차감 + `currency_balance` 증가인데, **차감도 `profiles` update이므로 이번과 같은 definer RPC가 필요**하다(update 정책을 열지 말 것). 아카이브/내역의 포인트 표시는 `programs.points`가 아니라 `point_transactions.amount`를 읽을 것.
- **[회수 완료 → ADR 0007]** **학생 본인 아카이브 화면**: `/student/archive`는 여전히 placeholder다. `participations_select_own`이 이미 필요한 권한을 준다(추가 정책 불필요).
- **[회수 완료 → ADR 0007]** **`profiles` 본인 수정(계열 선택 UI)**: `career_interest`만 열려면 컬럼 경계가 필요한데 RLS로는 불가능하고 컬럼 grant는 역할 구분이 안 된다 → **definer RPC**가 될 가능성이 높다. 절대 `for update using (id = auth.uid())`만 여는 것으로 끝내지 말 것(`points_*`가 함께 열린다).
- **신청 취소**: 확정 G-1(student-programs) 유지로 여전히 스코프 밖. 생기면 토큰·포인트와의 관계를 다시 본다(`completed` 취소는 원장 되돌리기를 뜻하므로 별도 설계).
- **`programs.status`/`popularity` 파생 전환**: 이번에도 하지 않는다. 실참여자 수로 파생하려면 **관리자에게 전교생 참여 조회 권한**이 필요한데, 그것이 정확히 이번에 열지 않기로 한 권한이다. 어떤 경우에도 학생 단위 랭킹으로 파생하지 않는다.
- **관리자 다중화**: 데모는 관리자 1명이지만 축 A/축 B 경계는 다중 관리자에서도 그대로 성립하도록 설계했다. 단 CLAUDE.md 2장 6번이 다중 관리자 관리 화면을 금지하므로 UI는 만들지 않는다.
- **`mentor_students` role 정합성**: 트리거를 추가하지 않았다(`is_admin()` 이중 방어). 매핑을 앱에서 편집하게 되면 그때 재검토.

---

## 케빈 확인 필요 → **해소 완료 (2026-07-23, 두 항목 모두 이 ADR 제안대로 확정)**

1. **시드 = 기존 2건의 날짜를 오늘로 이동한다** (추가 아님). 또래 멘토링(교내) + 지역 진로 박람회(교외). 총 20건이 유지되므로 ADR 0003 확정 F(16~20개)와 `assertSeedInvariants()`를 개정하지 않는다. 스펙 G-3의 "추가" 문구보다 이쪽이 우선한다.
2. **담당 학생 아카이브의 빈 상태를 그대로 둔다.** 담당 5명 중 QR 인증을 실제로 돌린 계정에만 기록이 생기고 나머지는 "아직 활동 기록이 없습니다" 빈 화면이 된다. **가짜 `completed` 참여를 시드하지 않는다** — ADR 0004의 "가짜 참여를 하드코딩하지 않는다"를 그대로 유지한다(개정 없음).

**추가 확정 — 구현을 2단계로 나눈다 (2026-07-23):**
- **1단계**: 마이그레이션 전체 적용 + QR(발급 → 입장 → 퇴장 → 포인트) + 관리자 셸·홈·스캔
- **2단계**: 프로그램 관리 + 담당 학생 아카이브 + PDF (**새 마이그레이션 0개** — 정책 6개를 1단계에서 함께 적용하므로 순수 frontend 작업)
- 근거: 아카이브가 보여줄 `completed` 데이터를 QR이 처음 만들므로 순서상 QR이 선행이고, 1단계 종료 시점에 "카메라로 찍어 포인트가 들어오는 것"을 실제로 검증할 수 있다.

**후속 에이전트는 위 3건을 재논의하지 말 것.** 아래는 결정 근거 원문이다.

## 케빈 확인 필요 원문 (해소 완료 — 위 참고)

1. **시드에 `dayOffset: 0` 2건을 "추가"하는 대신 "기존 2건의 날짜를 오늘로 옮긴다".** 확정 G-3의 문구는 "추가"지만, 그러면 20 → 22건이 되어 ADR 0003 **확정 F(16~20개)**와 시드 자체 검증(`rows.length > 20` 중단)에 걸린다. 관측 결과("관리자 홈에 오늘 프로그램 교내 1 + 교외 1")는 동일하다. → **반대하시면** 2건을 추가하고 확정 F 상한을 22로 개정 + `assertSeedInvariants` 수정.
2. **담당 학생 아카이브 시연용 데이터.** 아카이브는 `completed` 참여를 보여주는데, 그 데이터는 케빈이 학생 계정으로 QR 인증을 완료해야 생긴다. 즉 **담당 5명 중 실제로 활동 기록이 있는 학생은 시연에 쓴 계정 1~2명뿐**이고 나머지는 빈 화면이 된다. 그대로 두면(권장) "아직 활동 기록이 없습니다" 빈 상태가 4명에게 뜬다. → **원하시면** 나머지 학생용 `completed` 참여를 시드로 넣을 수 있으나, `participations` + `point_transactions` + `profiles.points_*` 세 곳의 정합을 스크립트가 함께 맞춰야 하고 ADR 0004의 "가짜 참여를 하드코딩하지 않는다"를 개정하게 된다.

---

## 영향받는 코드 위치

- `docs/db/schema.sql` — 본 ADR로 갱신 완료(타입 1종, `participations` 컬럼 2 + unique 2, 정책 개정 1 + 신규 6, 컬럼 grant 1, `point_transactions`, 함수 5 — `is_admin`은 1-1절, QR 함수 4개는 6번 절). **backend-agent는 이 파일을 마이그레이션으로 변환한다.**
- `supabase/migrations/{타임스탬프}_add_qr_auth_and_admin_boundaries.sql` — **backend-agent** 신규
- `scripts/seed-programs.mjs` — **backend-agent** 수정(결정 8)
- `src/lib/participationService.js`(가칭, 신규) — **frontend-agent**: 발급/검증 RPC 래퍼 + QR payload 조립/파싱
- `src/lib/programService.js` — **frontend-agent** 확장(관리자 프로그램 관리 CRUD, 오늘 프로그램 조회)
- `src/lib/archiveService.js`(가칭, 신규) — **frontend-agent**: 담당 학생 목록 + 완료 참여 조회
- `src/pages/StudentMyPage.jsx` — **frontend-agent** QR 진입 버튼(placeholder 유지, 확정 F-1)
- `src/components/student/StackViz.jsx` — **frontend-agent** 실데이터 연결(확정 B-1)
- `src/pages/AdminHomePage.jsx` — **frontend-agent** 전면 교체 / 관리자 셸·`/admin/scan`·`/admin/programs`·`/admin/students` 신규
- `src/components/Icon.jsx` — **frontend-agent** `ic-qr` 등 추가(이모지 금지)
- `README` — **frontend-agent** 시연 환경 전제(E-1: `npm run dev -- --host`, 카메라는 localhost/HTTPS만)

---

## 구현 가이드

### backend-agent가 구현할 부분

**순서대로 하나의 마이그레이션에 담는다** (`supabase/migrations/{타임스탬프}_add_qr_auth_and_admin_boundaries.sql`). 기존 마이그레이션의 주석 관례를 그대로 따를 것 — 특히 `[RLS 권한 경계]` 블록 형식(대상 역할 / 허용 행 / 불가능 / 용도).

1. **타입**: `point_transaction_type` enum (`do $$ ... exception when duplicate_object $$` 패턴).
1-1. **`public.is_admin()` 함수를 먼저 만든다.** 아래 정책 5개가 이 함수를 참조하므로 순서를 바꾸면 실패한다
   (`participations_insert_own`, `programs_insert/update_own_as_admin`, `profiles_select_mentored_students_as_admin`, `participations_select_mentored_as_admin`).
2. **`participations` 변경**
   - `alter table ... add column entry_token_expires_at timestamptz;` / `exit_token_expires_at`
   - `alter table ... add constraint participations_entry_token_unique unique (entry_token);` / `exit_token`
   - `drop policy if exists "participations_insert_own" ...; create policy ...` — **with check 9절을 한 절도 빼지 말 것.** 특히 `not public.is_admin()`(결정 6-1(b))과 `p.is_published = true`(결정 6-3)를 지우지 말 것. 두 절이 각각 무엇을 막는지 주석으로 남길 것.
   - `revoke insert ... from authenticated/anon;` + `grant insert (student_id, program_id) ... to authenticated;`
3. **`point_transactions`** 테이블 + comment + `enable row level security`. **정책을 만들지 말 것**(0개가 의도).
4. **나머지 함수 4개** — `docs/db/schema.sql` 6번 절(`is_admin`은 1-1절)을 그대로 옮긴다. 다음을 하나도 빠뜨리지 말 것:
   - 전부 `set search_path = ''`
   - `issue_participation_qr` / `verify_participation_qr` / `is_admin`은 `security definer`
   - `qr_generate_token`은 **아무에게도 grant하지 않는다**
   - 나머지는 `revoke all ... from public;` → `grant execute ... to authenticated;`
5. **관리자 정책 6개** — `docs/db/schema.sql` 7번 절 그대로. **`is_admin()`이 먼저 생성되어야 한다**(정책이 참조).
6. **`scripts/seed-programs.mjs` 수정**
   - `또래 멘토링 프로그램` `dayOffset: 2 → 0`, `지역 연계 진로 박람회` `dayOffset: 4 → 0`
   - `assertSeedInvariants()`에 검사 추가: `dayOffset === 0`인 행이 교내(`category[0] === 'h'`) 1건 이상 + 교외(`'e'`) 1건 이상. 실패 시 기존 스타일대로 `problems.push` + 중단.
   - 요약 출력에 "오늘 진행 프로그램 N건" 한 줄 추가. `node seed-programs.mjs --dry-run`으로 확인.
   - **프로그램 총 건수를 20건에서 늘리지 말 것**(확정 F).
7. **마이그레이션 하단에 시연 리셋 절차를 갱신할 것** — `delete from public.participations;`만으로는 부족하다:
   ```
   delete from public.participations;                                -- point_transactions 는 cascade
   update public.profiles set points_balance = 0, points_total = 0;  -- 잔액도 되돌려야 정합이 맞는다
   ```
8. **적용 후 실제로 뚫어볼 것** (anon 키 + 학생/관리자 계정. **service_role 금지**):
   - 학생: `update participations set status='completed'` → 0행
   - 학생: `update profiles set points_balance = 999999` → 0행
   - 학생: `insert participations {student_id, program_id, entry_token_expires_at: ...}` → 403
   - 학생: `insert point_transactions {...}` → 403
   - 학생: `rpc('verify_participation_qr', {p_token: '...'})` → **403**
   - 학생 A: `rpc('issue_participation_qr', {p_participation_id: 학생 B의 참여 id, p_type:'entry'})` → **403**
   - 학생: `insert programs {created_by: 본인}` → 403
   - **관리자: `insert participations {student_id: 본인, program_id: 본인 프로그램}` → 403** (결정 6-1(b) 폐루프 차단 확인)
   - 관리자: `select * from participations` → 담당 학생의 `completed` 행만(applied/entered는 0행)
   - 관리자: `select * from profiles` → 본인 + 담당 학생 5명만
   - 관리자: `update programs set created_by = null where id = 본인 프로그램` → 0행
   - 관리자: SQL로 어떤 프로그램의 `created_by`를 다른 uuid로 바꾼 뒤 그 프로그램 토큰 스캔 → `not_authorized`
   - 같은 토큰 2회 검증 → 두 번째 `used`/`already_completed`, `points_balance` 증가분이 **정확히 1회분**
   - `entry_token_expires_at`을 과거로 바꾼 뒤 스캔 → `expired`
   - `mentor_students`: 학생 계정으로 select → 0행

### frontend-agent가 구현할 부분

1. **`src/lib/participationService.js`(신규)**
   - `issueQr(participationId, type)` → `supabase.rpc('issue_participation_qr', { p_participation_id, p_type })`.
     반환은 `{ok:true, participation_id, type, token, expires_at}`이고, **QR payload는 그중 `token` 하나다**
     (결정 1-6, 2026-08-07 변경. 그 전에는 4필드를 `JSON.stringify` 했다 — 나머지 3개는 검증에 쓰이지 않으면서
     QR만 버전 7로 촘촘하게 만들었다).
     `{ok:false, reason}`(`already_completed`/`wrong_order`)이면 목록을 새로고침한다(화면 상태가 서버와 어긋난 것).
   - `verifyQr(rawScanned)` → **스캔 문자열이 JSON이면 `token` 필드만 꺼내고, 파싱 실패하면 문자열 전체를 토큰으로 취급**한 뒤 `supabase.rpc('verify_participation_qr', { p_token })`. 이 한 줄 덕에 **카메라와 수동 입력이 완전히 같은 경로**를 탄다(확정 D-1).
   - **`expires_at`을 검증에 쓰지 말 것.** 카운트다운 표시 전용이며, 발급 응답에서 읽는다(QR에 없다).
   - 403(`42501`)은 "권한 오류"로, `{ok:false, reason}`은 "인증 거부"로 **분리 표시**한다.
2. **학생 QR 목록/표시 모달**
   - 목록: `fetchMyParticipations()` 결과 중 `status !== 'completed'`. 버튼은 `applied`→입장 QR / `entered`→퇴장 QR.
   - 표시: `qrcode.react`로 토큰 인코딩(`level="Q"` — 결정 1-6) + **남은 유효시간(mm:ss)**. 프로토타입의 "5초 후 자동 처리" 카운트다운은 **삭제**(그게 곧 단순화다).
   - 만료 시 QR을 흐리게 + `다시 발급받기` → **같은 `issueQr()`를 다시 호출**하면 된다(재발급 = 덮어쓰기).
   - **폴링**은 `participations`만 조회한다(`participations_select_own`). realtime 구독 금지.
     주기는 QR 표시(또는 재발급) 후 **2분간 2초, 이후 10초**다 (2026-08-07 변경 — 단일 10초일 때 관리자
     화면에는 인증 성공이 즉시 뜨는데 학생 화면이 평균 5초·최악 10초 늦었다). 화면 복귀(`visibilitychange`)
     시에도 1회 확인한다.
   - 완료 화면: 큰 문구 = "입장이 확인되었습니다" / "참여가 기록되었습니다"(brand blue), 포인트는 **아래 한 줄 amber**. 컨페티·사운드·카운트업·이모지 금지. **퇴장 완료 지점에 만족도 평가 훅 주석**을 남길 것(B-1).
   - 학생 화면의 `+NNNP` 표시는 클라이언트가 이미 들고 있는 `programs.points`로 그린다(폴링은 금액을 돌려주지 않는다).
3. **관리자 셸 + 홈**
   - 홈: `created_by === 본인 && date === todayISO()` 필터(결정 7-5). 로컬 KST 기준, `toISOString()` 금지.
   - **참여자 수·명단·출석률·랭킹·학교 통계를 표시하지 말 것.**
4. **관리자 스캔 화면**
   - `html5-qrcode` 카메라 + 하단 접힌 영역에 **수동 코드 입력**(보조 수단임이 드러나게).
   - 결과 패널은 reason별 문구를 스펙 표 그대로. `camera_error`/`network_error`는 **기술 오류로 분리**(인증 거부와 혼동 금지).
   - 카메라 권한 거부/미지원 시 화면이 죽지 않고 안내 + 수동 입력 유도.
   - **시연 환경 전제 안내**(카메라는 `localhost` 또는 HTTPS에서만 — E-1)를 화면과 README에 남길 것.
   - 연속 스캔 가능(1건 처리 후 대기 복귀). 같은 토큰이 연속으로 읽히는 것은 프런트에서 디바운스하되, **중복 호출이 와도 서버가 `used`로 안전하게 처리**한다.
5. **관리자 프로그램 관리**
   - 조회: `programs`를 `is_published` 필터 없이 조회하면 RLS가 "게시된 전부 + 본인 미게시"를 내려준다. 화면에서는 **본인 것(`created_by === 본인`)만** 보여준다(수정 가능한 것과 목록이 일치해야 한다).
   - 등록: `created_by`에 **본인 id를 명시적으로 넣는다**(default를 두지 않았다 — ADR 0004 "주의 4"의 논리: default는 방어가 아니다).
   - `points`는 **150~3000, 끝자리 0**을 프런트에서도 검증(위반 시 `23514`/400). `capacity`는 비워도 된다(NULL = 정원 미정).
   - 게시중단은 `is_published = false` **토글**이다. **삭제 버튼을 만들지 말 것**(delete 정책 0개라 동작하지도 않는다).
   - **[원칙 가드]** `popularity`를 화면에 노출하거나 편집하게 만들지 말 것.
6. **관리자 담당 학생 아카이브**
   - 담당 목록: `mentor_students` select → 나온 `student_id`로 `profiles` 조회(이름·학번). **뷰/embed 금지**(정의자 권한 함정 — ADR 0003 6번), 병렬 2쿼리 + 클라이언트 결합.
   - 학생 1명 선택 → `participations`(RLS가 그 학생의 `completed`만 내려준다) + `programs` 결합.
   - **[원칙 1 가드] 학생 간 비교·정렬·순위·포인트 랭킹 금지.** `profiles`에서 `points_*`를 읽을 수는 있지만 **여러 학생을 나란히 비교하는 UI를 만들지 말 것.** 화면은 학생 1명 단위다.
   - PDF는 **클라이언트 렌더/인쇄**. 새 권한이 필요하다는 결론이 나오면 설계 문제이므로 멈추고 보고할 것.
7. **stackviz 연결(B-1)** — 결정 5. `programs.date` 기준 월 버킷, 교내=blue/교외=indigo, **amber 금지**, 숫자·레벨·게이지·비교 라벨 금지.
8. **방어적 렌더** — 게시중단된 프로그램의 참여 건은 `programs` 정보를 못 찾을 수 있다(결정 7-4). QR 목록·stackviz·아카이브 전부 **프로그램을 못 찾아도 죽지 않게** 처리할 것(제목 자리에 대체 문구).
9. **구현 순서**: **QR(발급·스캔·포인트) → 관리자 홈/프로그램 관리 → 담당 학생 아카이브.** 아카이브가 보여줄 `completed` 데이터는 QR 퇴장 인증이 처음 만들기 때문이다. 순서를 바꾸면 빈 화면만 보며 개발하게 된다.
